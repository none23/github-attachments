import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

test("CLI uploads raw bytes and prints only Markdown", async (context) => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/attachments");
    assert.equal(request.headers.authorization, "Bearer test-token");
    assert.equal(request.headers["x-filename"], "cli-fixture.txt");
    assert.equal(request.headers["x-alt-text"], "CLI fixture");
    assert.equal(request.headers["content-type"], "text/plain");

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    assert.equal(Buffer.concat(chunks).toString("utf8"), "attachment CLI fixture\n");

    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        markdown: "[cli-fixture.txt](https://example.test/a/id/cli-fixture.txt)",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const child = spawn(
    process.execPath,
    ["bin/github-attach.mjs", "test/fixtures/cli-fixture.txt", "--alt", "CLI fixture"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_ATTACHMENTS_TOKEN: "test-token",
        GITHUB_ATTACHMENTS_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode] = await once(child, "exit");

  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  assert.equal(exitCode, 0);
  assert.equal(
    Buffer.concat(stdout).toString("utf8"),
    "[cli-fixture.txt](https://example.test/a/id/cli-fixture.txt)\n",
  );
});
