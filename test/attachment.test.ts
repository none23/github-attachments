import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { attachmentKey } from "../src/attachment";
import { readObjectPrefix } from "../src/config";

const IMAGE_ID = "f7e0c819-f62a-4d66-82c8-2d598bbb5588";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("attachment delivery", () => {
  it("defaults and validates object prefixes", () => {
    expect(readObjectPrefix({ OBJECT_PREFIX: "" })).toBe("objects/");
    expect(readObjectPrefix({ OBJECT_PREFIX: "tenant/objects" })).toBe("tenant/objects/");
    expect(() => readObjectPrefix({ OBJECT_PREFIX: "../objects/" })).toThrow(
      "OBJECT_PREFIX must be a safe R2 key prefix",
    );
    expect(() => readObjectPrefix({ OBJECT_PREFIX: "tenant//objects/" })).toThrow(
      "OBJECT_PREFIX must be a safe R2 key prefix",
    );
  });

  it("streams safe images inline with cross-origin security headers", async () => {
    await seedObject(IMAGE_ID, IMAGE_BYTES, {
      filename: "screen shot.png",
      inline: "1",
    });

    const response = await fetchWorker(`/a/${IMAGE_ID}/screen%20shot.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("inline;");
    expect(response.headers.get("content-disposition")).toContain("screen shot.png");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(IMAGE_BYTES);
  });

  it("requires the exact decoded attachment filename", async () => {
    const filename = "résumé #1%.png";
    await seedObject(IMAGE_ID, IMAGE_BYTES, { filename, inline: "1" });

    const matching = await fetchWorker(`/a/${IMAGE_ID}/${encodeURIComponent(filename)}`);
    expect(matching.status).toBe(200);

    const mismatched = await fetchWorker(`/a/${IMAGE_ID}/resume.png`);
    expect(mismatched.status).toBe(404);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: "attachment_not_found" },
    });

    expect((await fetchWorker(`/a/${IMAGE_ID}`)).status).toBe(404);
    expect((await fetchWorker(`/a/${IMAGE_ID}/bad%encoding.png`)).status).toBe(404);
  });

  it("forces active content to download", async () => {
    const id = "36f38491-c389-4f50-a7de-2f77707ea088";
    await seedObject(id, new TextEncoder().encode("<h1>test</h1>"), {
      filename: "report.html",
      inline: "1",
      contentType: "text/html",
    });

    const response = await fetchWorker(`/a/${id}/report.html`);

    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await response.text()).toBe("<h1>test</h1>");
  });

  it("supports HEAD and conditional GET", async () => {
    await seedObject(IMAGE_ID, IMAGE_BYTES, { filename: "screenshot.png", inline: "1" });

    const head = await fetchWorker(`/a/${IMAGE_ID}/screenshot.png`, { method: "HEAD" });
    const etag = head.headers.get("etag");

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(IMAGE_BYTES.byteLength));
    expect(await head.text()).toBe("");
    expect(etag).not.toBeNull();

    const conditional = await fetchWorker(`/a/${IMAGE_ID}/screenshot.png`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(conditional.status).toBe(304);
  });

  it("returns structured errors for missing and expired objects", async () => {
    const expiredId = "820a0630-9af4-44c9-85ad-f2fd623b0352";
    await seedObject(expiredId, IMAGE_BYTES, {
      filename: "expired.png",
      inline: "1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const expired = await fetchWorker(`/a/${expiredId}/expired.png`, { method: "HEAD" });
    expect(expired.status).toBe(410);

    const disguisedExpired = await fetchWorker(`/a/${expiredId}/other.png`, { method: "HEAD" });
    expect(disguisedExpired.status).toBe(404);

    const missing = await fetchWorker("/a/7928e125-8d61-45ec-a2d3-2a5f639d342e/missing.png");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "attachment_not_found" },
    });
  });
});

async function seedObject(
  id: string,
  bytes: Uint8Array,
  metadata: {
    filename: string;
    inline: string;
    contentType?: string;
    expiresAt?: string;
  },
): Promise<void> {
  await env.ATTACHMENTS.put(attachmentKey(id, env), bytes, {
    httpMetadata: { contentType: metadata.contentType ?? "image/png" },
    customMetadata: {
      filename: metadata.filename,
      inline: metadata.inline,
      expiresAt: metadata.expiresAt ?? "2999-01-01T00:00:00.000Z",
    },
  });
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://example.test${path}`, init));
}
