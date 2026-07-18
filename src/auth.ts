import { errorResponse } from "./http";

const encoder = new TextEncoder();

export function isAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return false;
  }

  const actual = encoder.encode(authorization.slice("Bearer ".length));
  const expected = encoder.encode(env.UPLOAD_TOKEN);
  return (
    actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected)
  );
}

export function unauthorizedResponse(): Response {
  const response = errorResponse(401, "unauthorized", "A valid upload token is required.");
  response.headers.set("www-authenticate", 'Bearer realm="github-pr-attachments"');
  return response;
}
