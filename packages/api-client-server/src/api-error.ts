export function apiError(code: string, message: string, details?: unknown, status = 400): Response {
  return Response.json({ error: { code, message, details } }, { status });
}
