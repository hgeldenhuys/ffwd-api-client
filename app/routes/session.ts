import type { ActionFunctionArgs } from "react-router";
import { apiError, getEnv, constantTimeEqual, mintSessionToken, sessionCookie } from "@ffwd/api-client-server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError("method_not_allowed", "Use POST to sign in.", { method: request.method }, 405);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_json", "The request body must be JSON with a \"key\" field.");
  }
  const key = typeof body?.key === "string" ? body.key : "";
  const { accessKey, masterKey } = getEnv();
  if (!key || !constantTimeEqual(key, accessKey)) {
    return apiError("bad_key", "That access key is not correct: check it and try again.", undefined, 401);
  }
  const token = await mintSessionToken(masterKey);
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(token) } });
}
