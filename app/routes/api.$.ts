import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getApiClientHandler } from "../api-handler";

/**
 * The whole API client backend, mounted as ONE React Router resource route:
 * export const loader/action = ({ request }) => handler(request).
 * The handler itself is a plain fetch function from @ffwd/api-client-server.
 * The store is the host's shared one (chosen + logged once at boot in
 * app/store.ts). The auth is the host's shared access key gate
 * (see app/api-handler.ts).
 */

export async function loader({ request }: LoaderFunctionArgs) {
  return (await getApiClientHandler())(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return (await getApiClientHandler())(request);
}
