import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { attachmentKey } from "../src/attachment";

const TOKEN = "replace-with-a-random-secret";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface UploadBody {
  contentType: string;
  expiresAt: string;
  filename: string;
  id: string;
  markdown: string;
  size: number;
  url: string;
}

describe("attachment upload API", () => {
  it("requires bearer authentication", async () => {
    const response = await upload(PNG, { authorization: null });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("uploads an image, reports quota, serves it, and deletes it", async () => {
    const response = await upload(PNG, {
      filename: "new screenshot.png",
      altText: "A new [screen]",
    });
    const body = await response.json<UploadBody>();

    expect(response.status).toBe(201);
    expect(body.filename).toBe("new screenshot.png");
    expect(body.contentType).toBe("image/png");
    expect(body.size).toBe(PNG.byteLength);
    expect(body.markdown).toBe(`![A new \\[screen\\]](${body.url})`);
    expect(response.headers.get("location")).toBe(body.url);

    const stored = await env.ATTACHMENTS.head(attachmentKey(body.id, env));
    expect(stored?.customMetadata).toMatchObject({
      filename: "new screenshot.png",
      inline: "1",
    });

    const served = await exports.default.fetch(new Request(body.url));
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const quota = await authenticatedFetch("/v1/quota");
    expect(quota.status).toBe(200);
    await expect(quota.json()).resolves.toMatchObject({ objectCount: 1, storedBytes: 8 });

    const deleted = await authenticatedFetch(`/v1/attachments/${body.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await env.ATTACHMENTS.head(attachmentKey(body.id, env))).toBeNull();

    const missing = await exports.default.fetch(new Request(body.url));
    expect(missing.status).toBe(404);
  });

  it("uses the configured object prefix", async () => {
    const originalPrefix = env.OBJECT_PREFIX;
    env.OBJECT_PREFIX = "users/example/objects/";

    try {
      const response = await upload(PNG, { filename: "namespaced.png" });
      const body = await response.json<UploadBody>();

      expect(response.status).toBe(201);
      expect(await env.ATTACHMENTS.head(`users/example/objects/${body.id}`)).not.toBeNull();

      const served = await exports.default.fetch(new Request(body.url));
      expect(served.status).toBe(200);

      const deleted = await authenticatedFetch(`/v1/attachments/${body.id}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(204);
      expect(await env.ATTACHMENTS.head(`users/example/objects/${body.id}`)).toBeNull();
    } finally {
      env.OBJECT_PREFIX = originalPrefix;
    }
  });

  it("returns link Markdown for non-image files", async () => {
    const bytes = new TextEncoder().encode("test log");
    const response = await upload(bytes, { filename: "run.log", contentType: "text/plain" });
    const body = await response.json<UploadBody>();

    expect(response.status).toBe(201);
    expect(body.markdown).toBe(`[run.log](${body.url})`);

    const served = await exports.default.fetch(new Request(body.url));
    expect(served.headers.get("content-disposition")).toContain("attachment;");
    expect(await served.text()).toBe("test log");
  });

  it("validates filenames, body length, and image size", async () => {
    const badFilename = await upload(PNG, { filename: ".." });
    expect(badFilename.status).toBe(400);

    const missingLength = await authenticatedFetch("/v1/attachments", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-filename": "test.png",
      },
    });
    expect(missingLength.status).toBe(411);

    const tooLarge = await authenticatedFetch("/v1/attachments", {
      method: "POST",
      headers: {
        "content-length": "10000001",
        "content-type": "image/png",
        "x-filename": "large.png",
      },
      body: PNG,
    });
    expect(tooLarge.status).toBe(413);
  });
});

async function upload(
  bytes: Uint8Array,
  options: {
    altText?: string;
    authorization?: string | null;
    contentType?: string;
    filename?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-length": String(bytes.byteLength),
    "content-type": options.contentType ?? "image/png",
    "x-filename": options.filename ?? "screenshot.png",
  };
  if (options.authorization !== null) {
    headers.authorization = options.authorization ?? `Bearer ${TOKEN}`;
  }
  if (options.altText !== undefined) {
    headers["x-alt-text"] = options.altText;
  }

  return authenticatedFetch("/v1/attachments", { method: "POST", headers, body: bytes }, false);
}

async function authenticatedFetch(
  path: string,
  init: RequestInit = {},
  addAuthorization = true,
): Promise<Response> {
  const request = new Request(`https://example.test${path}`, init);
  if (addAuthorization) {
    request.headers.set("authorization", `Bearer ${TOKEN}`);
  }
  return exports.default.fetch(request);
}
