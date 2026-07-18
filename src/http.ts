export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse<ApiErrorBody>({ error: { code, message } }, status);
}

export function jsonResponse<T>(body: T, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("x-content-type-options", "nosniff");

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}
