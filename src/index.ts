import { DurableObject } from "cloudflare:workers";
import { parseAttachmentId, serveAttachment } from "./attachment";
import { errorResponse, jsonResponse } from "./http";

export class QuotaLedger extends DurableObject<Env> {
  async ping(): Promise<"ok"> {
    return "ok";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({ status: "ok", service: "github-pr-attachments" });
      }

      const attachmentId = parseAttachmentId(url.pathname);
      if (
        attachmentId !== null &&
        (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS")
      ) {
        return await serveAttachment(request, env, attachmentId);
      }

      return errorResponse(404, "not_found", "The requested endpoint does not exist.");
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "request_failed",
          method: request.method,
          requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return errorResponse(500, "internal_error", "The service could not complete the request.");
    }
  },
} satisfies ExportedHandler<Env>;
