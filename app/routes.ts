import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("/sign-in", "routes/sign-in.tsx"),
  route("/", "routes/app.tsx"),
  // sign-in endpoint (mints the access-key session cookie)
  route("/api/session", "routes/session.ts"),
  // everything else under /api is the API client handler, mounted as one
  // resource route
  route("/api/*", "routes/api.$.ts"),
  // any other path answers the sign-in page
  route("*", "routes/sign-in.tsx", { id: "catchall-sign-in" }),
] satisfies RouteConfig;
