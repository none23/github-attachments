import { readObjectPrefix } from "./config";
import { errorResponse } from "./http";

const ATTACHMENT_PATH =
  /^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([^/]+)$/i;

const INLINE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export interface AttachmentPath {
  filename: string;
  id: string;
}

export function attachmentKey(id: string, env: Pick<Env, "OBJECT_PREFIX">): string {
  return `${readObjectPrefix(env)}${id}`;
}

export function parseAttachmentPath(pathname: string): AttachmentPath | null {
  const match = ATTACHMENT_PATH.exec(pathname);
  const id = match?.[1];
  const encodedFilename = match?.[2];
  if (id === undefined || encodedFilename === undefined) {
    return null;
  }

  try {
    return { filename: decodeURIComponent(encodedFilename), id: id.toLowerCase() };
  } catch {
    return null;
  }
}

export async function serveAttachment(
  request: Request,
  env: Env,
  attachment: AttachmentPath,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-max-age": "86400",
      },
    });
  }

  const key = attachmentKey(attachment.id, env);
  const object =
    request.method === "HEAD"
      ? await env.ATTACHMENTS.head(key)
      : await env.ATTACHMENTS.get(key, { onlyIf: request.headers });

  if (object === null) {
    return errorResponse(404, "attachment_not_found", "The attachment does not exist.");
  }

  if (object.customMetadata?.filename !== attachment.filename) {
    if (hasBody(object)) {
      await object.body.cancel();
    }
    return errorResponse(404, "attachment_not_found", "The attachment does not exist.");
  }

  if (isExpired(object.customMetadata?.expiresAt)) {
    if (hasBody(object)) {
      await object.body.cancel();
    }
    return errorResponse(410, "attachment_expired", "The attachment has expired.");
  }

  const headers = attachmentHeaders(object);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  if (!hasBody(object)) {
    const status =
      request.headers.has("if-none-match") || request.headers.has("if-modified-since") ? 304 : 412;
    return new Response(null, { status, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

function hasBody(object: R2Object): object is R2ObjectBody {
  return "body" in object && object.body instanceof ReadableStream;
}

function attachmentHeaders(object: R2Object): Headers {
  const headers = new Headers();
  const filename = object.customMetadata?.filename ?? "attachment";
  const contentType = normalizeContentType(
    object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  const inline = object.customMetadata?.inline === "1" && INLINE_TYPES.has(contentType);

  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "public, max-age=86400, immutable");
  headers.set(
    "content-disposition",
    contentDisposition(inline ? "inline" : "attachment", filename),
  );
  headers.set("content-length", String(object.size));
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("content-type", contentType);
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("x-content-type-options", "nosniff");

  return headers;
}

function contentDisposition(disposition: "attachment" | "inline", filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180);
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${disposition}; filename="${ascii || "attachment"}"; filename*=UTF-8''${encoded}`;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (expiresAt === undefined) {
    return false;
  }

  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function normalizeContentType(contentType: string): string {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}
