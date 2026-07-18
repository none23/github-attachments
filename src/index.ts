import { DurableObject } from "cloudflare:workers";

export class QuotaLedger extends DurableObject<Env> {
  async ping(): Promise<"ok"> {
    return "ok";
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    return Response.json(
      { error: { code: "not_found", message: "The requested endpoint does not exist." } },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
