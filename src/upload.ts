import { attachmentKey } from "./attachment";
import { isAuthorized, unauthorizedResponse } from "./auth";
import { readLimits, type ServiceLimits } from "./config";
import { errorResponse, jsonResponse } from "./http";
import type { QuotaLimits, ReserveResult } from "./quota";

const INLINE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const ATTACHMENT_DELETE_PATH =
  /^\/v1\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

interface UploadResponse {
  contentType: string;
  etag: string;
  expiresAt: string;
  filename: string;
  id: string;
  markdown: string;
  size: number;
  url: string;
}

export async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorizedResponse();
  }

  const limits = readLimits(env);
  const filename = sanitizeFilename(decodeFilenameHeader(request.headers));
  if (filename === null) {
    return errorResponse(400, "invalid_filename", "X-Filename must contain a valid filename.");
  }

  const size = contentLength(request.headers.get("content-length"));
  if (size === null) {
    return errorResponse(411, "length_required", "A valid Content-Length header is required.");
  }
  if (size === 0) {
    return errorResponse(400, "empty_file", "Empty attachments are not supported.");
  }

  const contentType = normalizeContentType(request.headers.get("content-type"));
  const inline = INLINE_TYPES.has(contentType);
  const fileLimit = inline ? limits.maxImageBytes : limits.maxFileBytes;
  if (size > fileLimit) {
    return errorResponse(
      413,
      "file_too_large",
      `The attachment exceeds the ${fileLimit} byte limit.`,
    );
  }
  if (request.body === null) {
    return errorResponse(400, "missing_body", "The attachment body is required.");
  }

  const now = Date.now();
  const expiresAtTimestamp = now + limits.retentionDays * 86_400_000;
  const expiresAt = new Date(expiresAtTimestamp).toISOString();
  const id = crypto.randomUUID().toLowerCase();
  const key = attachmentKey(id, env);
  const ledger = env.QUOTA.getByName("service");
  const reservation = await ledger.reserve(
    { id, objectKey: key, size, createdAt: now, expiresAt: expiresAtTimestamp },
    quotaLimits(limits),
  );

  if (!reservation.ok) {
    return quotaError(reservation);
  }

  let objectWritten = false;
  try {
    const object = await env.ATTACHMENTS.put(key, request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        expiresAt,
        filename,
        inline: inline ? "1" : "0",
        uploadedAt: new Date(now).toISOString(),
      },
    });
    objectWritten = true;

    if (object.size !== size || !(await ledger.finalize(id, object.size))) {
      await env.ATTACHMENTS.delete(key);
      await ledger.rollback(id);
      return errorResponse(
        400,
        "size_mismatch",
        "The received attachment size did not match Content-Length.",
      );
    }

    const publicUrl = `${new URL(request.url).origin}/a/${id}/${encodeUrlPathSegment(filename)}`;
    const altText = sanitizeAltText(request.headers.get("x-alt-text"), filename);
    const markdown = inline
      ? `![${escapeMarkdown(altText)}](${publicUrl})`
      : `[${escapeMarkdown(filename)}](${publicUrl})`;
    const body: UploadResponse = {
      contentType,
      etag: object.etag,
      expiresAt,
      filename,
      id,
      markdown,
      size: object.size,
      url: publicUrl,
    };

    return jsonResponse(body, 201, { location: publicUrl });
  } catch (error) {
    if (objectWritten) {
      await env.ATTACHMENTS.delete(key);
    }
    await ledger.release(id);
    console.error(
      JSON.stringify({
        event: "upload_failed",
        attachmentId: id,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return errorResponse(500, "upload_failed", "The attachment could not be stored.");
  }
}

export async function handleDelete(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorizedResponse();
  }

  const id = ATTACHMENT_DELETE_PATH.exec(pathname)?.[1]?.toLowerCase();
  if (id === undefined) {
    return errorResponse(404, "not_found", "The requested endpoint does not exist.");
  }

  await env.ATTACHMENTS.delete(attachmentKey(id, env));
  await env.QUOTA.getByName("service").release(id);
  return new Response(null, { status: 204 });
}

export async function handleQuota(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorizedResponse();
  }

  const limits = readLimits(env);
  const snapshot = await env.QUOTA.getByName("service").quota(Date.now(), quotaLimits(limits));
  return jsonResponse({
    ...snapshot,
    dailyUploadLimit: limits.dailyUploadLimit,
    monthlyUploadLimit: limits.monthlyUploadLimit,
  });
}

function sanitizeFilename(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const sanitized = [...replaceUnsafeCharacters(raw, "_", true).trim()].slice(0, 200).join("");
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".." ? sanitized : null;
}

function decodeFilenameHeader(headers: Headers): string | null {
  const raw = headers.get("x-filename");
  const encoding = headers.get("x-filename-encoding");
  if (encoding === null) {
    return raw;
  }
  if (encoding !== "percent" || raw === null) {
    return null;
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function sanitizeAltText(raw: string | null, filename: string): string {
  const fallback = filename.replace(/\.[^.]+$/, "") || filename;
  if (raw === null) {
    return fallback;
  }
  const sanitized = [...replaceUnsafeCharacters(raw, " ", false).trim()].slice(0, 300).join("");
  return sanitized || fallback;
}

function normalizeContentType(raw: string | null): string {
  const normalized = raw?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function contentLength(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function quotaLimits(limits: ServiceLimits): QuotaLimits {
  return {
    dailyUploadLimit: limits.dailyUploadLimit,
    maxObjects: limits.maxObjects,
    maxStoredBytes: limits.maxStoredBytes,
    monthlyUploadLimit: limits.monthlyUploadLimit,
  };
}

function quotaError(result: Exclude<ReserveResult, { ok: true }>): Response {
  switch (result.code) {
    case "daily_limit":
    case "monthly_limit":
      return errorResponse(429, "upload_limit", "The upload operation limit has been reached.");
    case "object_limit":
      return errorResponse(507, "object_limit", "The attachment object limit has been reached.");
    case "storage_limit":
      return errorResponse(507, "quota_exceeded", "The attachment storage quota has been reached.");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
}

function encodeUrlPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function replaceUnsafeCharacters(
  value: string,
  replacement: string,
  includePathSeparators: boolean,
): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isControl = codePoint < 32 || codePoint === 127;
      const isPathSeparator = includePathSeparators && (character === "/" || character === "\\");
      return isControl || isPathSeparator ? replacement : character;
    })
    .join("");
}
