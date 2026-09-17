import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  redirect,
  useRouteLoaderData,
} from "react-router";
import { getEnv, sessionFromRequest, verifySessionToken } from "@ffwd/api-client-server";
import stylesheet from "~/tailwind.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];

export const meta: MetaFunction = () => [
  { title: "ffwd API client" },
  { name: "description", content: "A browser-hosted API client that speaks Postman collections." },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/sign-in") {
    return { authed: false };
  }
  let authed = false;
  try {
    const { masterKey } = getEnv();
    authed = await verifySessionToken(masterKey, sessionFromRequest(request));
  } catch {
    authed = false;
  }
  if (!authed) throw redirect("/sign-in");
  return { authed: true };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <Outlet />
    </>
  );
}

export function useAuthed() {
  const data = useRouteLoaderData<typeof loader>("root") as { authed: boolean } | undefined;
  return data?.authed ?? false;
}
