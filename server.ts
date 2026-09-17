import { createRequestHandler } from "react-router";
import { loadEnv } from "@ffwd/api-client-server";
import { getSharedStore } from "./app/store";
import { hostAuth } from "./app/api-handler";

// Read NODE_ENV through an alias: bundlers statically replace the literal
// `process.env.NODE_ENV` member expression (same reasoning as env.ts).
const env: Record<string, string | undefined> = process.env;

// Validate the environment FIRST: a missing variable stops the server with a
// message that names the variable and the exact command that sets it.
loadEnv();

// Choose + log the auth (the shared access key gate).
hostAuth();

// The store choice (logged by the core package's storeFromEnv).
await getSharedStore();

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
let build: any;
{
  // Bun 1.3.11 cannot load react-dom's production CJS server build
  // ("Expected CommonJS module to have a function wrapper" in
  // react-dom/server.bun.js) — a Bun runtime bug, not an app one. Pick the dev
  // server build for the import, then restore NODE_ENV: everything in the app
  // (env alias, proxy policy) reads NODE_ENV at request time, so the
  // production refusal still holds.
  const realNodeEnv = env.NODE_ENV;
  if (realNodeEnv === "production") env.NODE_ENV = "development";
  try {
    // @ts-ignore built output
    build = await import("./build/server/index.js");
  } finally {
    env.NODE_ENV = realNodeEnv;
  }
}

const handler = createRequestHandler(build as any);

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    // serve the built client assets (a custom handler must do this itself)
    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(`./build/client${url.pathname}`);
      if (await file.exists()) return new Response(file);
    }
    try {
      return await handler(req);
    } catch (err: any) {
      console.error("[server] unhandled error:", err?.stack ?? err);
      return Response.json(
        { error: { code: "internal", message: "Something went wrong handling that request: check the server log.", details: {} } },
        { status: 500 }
      );
    }
  },
});

console.log(`ffwd API client listening on http://localhost:${server.port}`);
