/**
 * Host-side manager for the sandbox worker: ONE long-lived Bun Worker per
 * process (R5, crash containment) plus the R6 budget — at most 4 script
 * executions in flight per process, queued beyond that with a 30 s queue
 * timeout. A worker death fails every pending job with a house error and the
 * worker is restarted lazily on the next send.
 *
 * The worker file is built twice over: in the repo the package runs straight
 * from src (bun test / dev), and the package build emits dist/worker.js next
 * to dist/index.js.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ScriptJob, ScriptJobOk } from "./worker";

export const MAX_IN_FLIGHT = 4;
export const QUEUE_TIMEOUT_MS = 30_000;
export const PHASE_TIME_LIMIT_MS = 5_000;
export const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

export type WorkerOutcome =
  | ScriptJobOk
  | { id: number; ok: false; crashed: boolean; message: string };

function workerUrl(): URL {
  const here = import.meta.url;
  if (here.includes("/src/scripts/")) return new URL("./worker.ts", here);
  // Bundled contexts (a host app bundling this package) have a meaningless
  // import.meta.url — locate the real package's dist/worker.js instead.
  try {
    const req = createRequire(import.meta.url);
    // the package root lives at packages/…; the worker sits at dist/worker.js
    const pkgJson = req.resolve("@ffwd/api-client-server/package.json");
    return new URL("dist/worker.js", new URL(".", pathToFileURL(pkgJson)));
  } catch {
    return new URL("./worker.js", here);
  }
}

interface Pending {
  resolve: (o: WorkerOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ScriptSandboxPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight = 0;
  private queue: { job: Omit<ScriptJob, "id">; pending: Pending; enqueueTimer: ReturnType<typeof setTimeout> }[] = [];
  private pending = new Map<number, Pending>();
  private crashListener: ((message: string) => void) | null = null;

  /** Observe crashes (the sender turns them into the house error). */
  onCrash(listener: (message: string) => void) {
    this.crashListener = listener;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const wurl = workerUrl();
    if (process.env.FFWD_DEBUG_WORKER) console.error("[ffwd scripts] worker url:", wurl.href);
    const w = new Worker(wurl);
    // an idle sandbox must not keep the process alive (bun test would hang)
    try { (w as any).unref(); } catch {}
    w.onmessage = (e: MessageEvent<WorkerOutcome>) => {
      const p = this.pending.get(e.data.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(e.data.id);
        this.inFlight--;
        p.resolve(e.data);
        this.drain();
      }
    };
    const die = () => {
      const err = (msg: string) => {
        this.crashListener?.(msg);
        return {
          id: -1,
          ok: false as const,
          crashed: true as const,
          message: msg,
        };
      };
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve(err("the script sandbox crashed and was restarted; the send was not performed"));
      }
      this.pending.clear();
      this.inFlight = 0;
      for (const q of this.queue) {
        clearTimeout(q.enqueueTimer);
        q.pending.resolve(err("the script sandbox crashed and was restarted; the send was not performed"));
      }
      this.queue = [];
      this.worker = null;
    };
    (w as any).onexit = die;
    w.onerror = (e: any) => {
      if (process.env.FFWD_DEBUG_WORKER) console.error("[ffwd scripts] worker error:", e?.message ?? e, e?.stack ?? "");
      die();
    };
    this.worker = w;
    return w;
  }

  private drain() {
    if (this.queue.length === 0 || this.inFlight >= MAX_IN_FLIGHT) return;
    const next = this.queue.shift()!;
    this.start(next.job, next.pending);
  }

  private start(job: Omit<ScriptJob, "id">, pending: Pending) {
    const w = this.ensureWorker();
    const id = this.nextId++;
    this.inFlight++;
    this.pending.set(id, pending);
    const full: ScriptJob = { ...job, id };
    w.postMessage(full);
  }

  run(job: Omit<ScriptJob, "id">): Promise<WorkerOutcome> {
    return new Promise<WorkerOutcome>((resolve) => {
      const pending: Pending = {
        resolve,
        timer: setTimeout(() => {
          // the phase itself is interrupt-limited at 5 s; a job stuck past the
          // queue timeout means the worker is wedged: kill and fail as crash
          this.pending.delete(-1);
          resolve({
            id: -1,
            ok: false,
            crashed: true,
            message: "the script sandbox did not answer in time; the send was not performed. Try again.",
          });
        }, QUEUE_TIMEOUT_MS + PHASE_TIME_LIMIT_MS + 5_000),
      };
      if (this.inFlight >= MAX_IN_FLIGHT) {
        const enqueueTimer = setTimeout(() => {
          const i = this.queue.findIndex((q) => q.pending === pending);
          if (i >= 0) this.queue.splice(i, 1);
          resolve({
            id: -1,
            ok: false,
            crashed: false,
            message: "the script sandbox is busy: too many sends are running scripts right now (cap 4). Retry in a moment.",
          });
        }, QUEUE_TIMEOUT_MS);
        this.queue.push({ job, pending, enqueueTimer });
        return;
      }
      this.start(job, pending);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    for (const q of this.queue) clearTimeout(q.enqueueTimer);
    this.queue = [];
    this.inFlight = 0;
  }
}

// One pool per process.
let pool: ScriptSandboxPool | null = null;

export function scriptSandbox(): ScriptSandboxPool {
  if (!pool) {
    pool = new ScriptSandboxPool();
    pool.onCrash((message) => {
      // The next run() recreates the worker lazily; log for the host operator.
      console.error(`[ffwd scripts] ${message}`);
    });
  }
  return pool;
}
