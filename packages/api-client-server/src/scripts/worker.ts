/**
 * The script sandbox worker. ONE long-lived Bun Worker per process (crash
 * isolation, not security isolation): the QuickJS WASM library aborts the
 * whole heap on certain fatal states (leaked handles at runtime dispose, an
 * OOM during internal bookkeeping), and that abort must kill the worker —
 * never the server. The pool restarts it on exit.
 *
 * Per job: a FRESH QuickJS runtime + context (≈1 ms), memory-limited and
 * interrupt-limited; the prelude is evaluated, then each script in order.
 * Security comes from the sandbox itself: `fetch`, `require` (our shim
 * excepted), `process` and `Bun` do not exist inside QuickJS.
 */

import { newQuickJSWASMModule, type QuickJSWASMModule, type QuickJSContext } from "quickjs-emscripten";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { PRELUDE } from "./prelude";

export interface ScriptJob {
  id: number;
  /** JSON-encoded PhaseState (see run.ts). */
  stateJson: string;
  scripts: { name: string; code: string }[];
  memoryLimitBytes: number;
  timeLimitMs: number;
}

export interface ScriptPhaseError {
  message: string;
  line?: number;
  script?: string;
}

export interface ScriptJobOk {
  id: number;
  ok: true;
  result: any;
  error: ScriptPhaseError | null;
  elapsedMs: number;
}

export interface ScriptJobCrashed {
  id: number;
  ok: false;
  crashed: true;
  message: string;
}

let mod: QuickJSWASMModule | null = null;
let nextJob: ScriptJob | null = null;

function hostCrypto(op: string, a: string, b: string, mode: string): string {
  switch (op) {
    case "sha256hex":
      return createHash("sha256").update(a, "utf8").digest("hex");
    case "sha256hexbytes":
      return createHash("sha256").update(Buffer.from(a, "hex")).digest("hex");
    case "md5hex":
      return createHash("md5").update(a, "utf8").digest("hex");
    case "md5hexbytes":
      return createHash("md5").update(Buffer.from(a, "hex")).digest("hex");
    case "hmacsha256hex": {
      // mode letters: "a" = the message is hex bytes; "k" = the key is hex bytes
      const data = mode.includes("a") ? Buffer.from(a, "hex") : Buffer.from(a, "utf8");
      const key = mode.includes("k") ? Buffer.from(b, "hex") : Buffer.from(b, "utf8");
      return createHmac("sha256", key).update(data).digest("hex");
    }
    case "uuid":
      return randomUUID();
    default:
      throw new Error(`unknown crypto op ${op}`);
  }
}

function errorFromDump(dumped: any): ScriptPhaseError {
  let message = "script failed";
  let line: number | undefined;
  if (dumped && typeof dumped === "object") {
    message = typeof dumped.message === "string" && dumped.message ? dumped.message : String(dumped);
    if (message === "interrupted") message = "script timed out: the time limit for this script phase was reached";
    else if (message === "out of memory") message = "script ran out of memory: the 64 MB sandbox cap was reached";
    const stack = typeof dumped.stack === "string" ? dumped.stack : "";
    const m = /eval\.js:(\d+)/.exec(stack);
    const ln = m ? Number(m[1]) : undefined;
    if (ln !== undefined && Number.isFinite(ln)) line = ln;
  } else if (typeof dumped === "string" && dumped) {
    message = dumped;
  }
  return line !== undefined ? { message, line } : { message };
}

/** Evaluate the prelude (raw global code; it defines __f and pm). */
function runPrelude(vm: QuickJSContext): { ok: true } | { ok: false; error: ScriptPhaseError } {
  const res = vm.evalCode(PRELUDE);
  if (res.error) {
    const dumped = vm.dump(res.error);
    res.dispose();
    return { ok: false, error: errorFromDump(dumped) };
  }
  res.dispose();
  return { ok: true };
}

/**
 * Run one user script through the sandbox's own catch wrapper (__f.run):
 * interrupt and out-of-memory aborts surface as ordinary QuickJS exceptions
 * that the wrapper can serialise, so no error class is invisible to us.
 */
function runScript(vm: QuickJSContext, code: string): { ok: true } | { ok: false; error: ScriptPhaseError } {
  const res = vm.evalCode(`__f.run(function(){${code}\n})`);
  if (res.error) {
    const dumped = vm.dump(res.error);
    res.dispose();
    return { ok: false, error: errorFromDump(dumped) };
  }
  const dumped = vm.dump(res.value);
  res.dispose();
  if (typeof dumped === "string" && dumped.startsWith("{")) {
    try {
      const parsed = JSON.parse(dumped);
      // marker tokens survive the JSON round trip even when the sandbox is in
      // a state where building the message string itself could fail
      if (parsed.message === "__FFWD_INTERRUPTED__") {
        return { ok: false, error: { message: "script timed out: the time limit for this script phase was reached" } };
      }
      if (parsed.message === "__FFWD_OUT_OF_MEMORY__") {
        return { ok: false, error: { message: "script ran out of memory: the 64 MB sandbox cap was reached" } };
      }
      return { ok: false, error: errorFromDump(parsed) };
    } catch {
      return { ok: false, error: { message: "script failed (the error could not be read)" } };
    }
  }
  if (dumped !== "" && dumped !== null && dumped !== undefined) {
    return { ok: false, error: { message: "script failed: the sandbox could not run the wrapper" } };
  }
  return { ok: true };
}

async function handleJob(job: ScriptJob): Promise<ScriptJobOk | ScriptJobCrashed> {
  const started = performance.now();
  try {
    mod ??= await newQuickJSWASMModule();
    const QJS = mod;

    const rt = QJS.newRuntime();
    rt.setMemoryLimit(job.memoryLimitBytes);
    const deadline = performance.now() + job.timeLimitMs;
    rt.setInterruptHandler(() => performance.now() > deadline);
    const vm = rt.newContext();

    let error: ScriptPhaseError | null = null;
    let result: any = null;
    try {
      // the one host function: crypto primitives (the sandbox has no WebCrypto)
      const cryptoFn = vm.newFunction("__ffwdCrypto", (...args: any[]) => {
        const op = vm.getString(args[0]);
        const a = vm.getString(args[1]);
        const b = vm.getString(args[2]);
        const mode = args[3] !== undefined ? vm.getString(args[3]) : "";
        if (op.length > 64 || a.length > 1024 * 1024 || b.length > 1024 * 1024) {
          throw new Error("pm.crypto: argument caps exceeded (1 MB)");
        }
        return vm.newString(hostCrypto(op, a, b, mode));
      });
      vm.setProp(vm.global, "__ffwdCrypto", cryptoFn);
      cryptoFn.dispose();

      const stateHandle = vm.newString(job.stateJson);
      vm.setProp(vm.global, "__FFWD_STATE", stateHandle);
      stateHandle.dispose();

      const prelude = runPrelude(vm);
      if (!prelude.ok) {
        error = { ...prelude.error, script: "(prelude)" };
      } else {
        for (const script of job.scripts) {
          const setRes = vm.evalCode(`__f.setCurrentScript(${JSON.stringify(script.name)})`);
          setRes.dispose();
          const r = runScript(vm, script.code);
          if (!r.ok) {
            error = { ...r.error, script: script.name };
            break;
          }
        }
      }

      if (!error) {
        const c = vm.evalCode("JSON.stringify(__f.collect())");
        if (c.error) {
          error = errorFromDump(vm.dump(c.error));
          c.dispose();
        } else {
          result = JSON.parse(vm.getString(c.value));
          c.dispose();
        }
      }
    } finally {
      vm.dispose();
      rt.dispose();
    }

    return { id: job.id, ok: true, result, error, elapsedMs: Math.round(performance.now() - started) };
  } catch (e: any) {
    // A throw here is a WASM-level fault (abort, OOM of the module itself,
    // leaked-handle assertion at dispose). The worker is about to be killed
    // or is unhealthy; the pool fails the job as a crash and restarts.
    return { id: job.id, ok: false, crashed: true, message: String(e?.message ?? e) };
  }
}

self.onmessage = (e: MessageEvent<ScriptJob>) => {
  nextJob = e.data;
  Promise.resolve().then(pump);
};

async function pump() {
  const job = nextJob;
  if (!job) return;
  nextJob = null;
  const out = await handleJob(job);
  (self as any).postMessage(out);
}
