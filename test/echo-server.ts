/**
 * A tiny echo server for tests that need a real HTTP round trip through the
 * send path (the handler's own /api/ffwd/_echo is mounted by the app server;
 * at the handler level there is no listening socket, so tests run one).
 */
let server: any = null;

export const EchoServer = {
  get url(): string {
    return `http://127.0.0.1:${server!.port}`;
  },
  async start(): Promise<void> {
    if (server) return;
    // port 0 → an ephemeral free port
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => (headers[k] = v));
        return req.text().then((body) =>
          Response.json({
            method: req.method,
            path: u.pathname,
            query: Object.fromEntries(u.searchParams.entries()),
            headers,
            body,
          })
        );
      },
    });
  },
  async stop(): Promise<void> {
    server?.stop(true);
    server = null;
  },
};
