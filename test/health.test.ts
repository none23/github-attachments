import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("health endpoint", () => {
  it("reports that the worker is ready", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/healthz"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns a structured 404", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "The requested endpoint does not exist." },
    });
  });
});
