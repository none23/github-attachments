import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve("bin/github-attach.mjs");
const FIXTURE = resolve("test/fixtures/cli-fixture.txt");
const SKILL_UPLOADER = resolve("skills/attach-github-pr-files/scripts/upload.sh");
const EXPECTED_MARKDOWN = "[cli-fixture.txt](https://example.test/a/id/cli-fixture.txt)\n";

test("CLI uploads raw bytes and prints only Markdown", async (context) => {
  const serviceUrl = await startServer(context, { alt: "CLI fixture", token: "test-token" });
  const result = await run(process.execPath, [CLI, FIXTURE, "--alt", "CLI fixture"], {
    ...process.env,
    GITHUB_ATTACHMENTS_TOKEN: "test-token",
    GITHUB_ATTACHMENTS_URL: serviceUrl,
  });

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, EXPECTED_MARKDOWN);
});

test("repository .env overrides process configuration", async (context) => {
  const serviceUrl = await startServer(context, { alt: "Repository", token: "repo-token" });
  const repository = await temporaryRepository(context);
  await writeFile(
    join(repository, ".env"),
    "GITHUB_ATTACHMENTS_TOKEN=repo-token\nGITHUB_ATTACHMENTS_URL=http://127.0.0.1:1\n",
  );

  const result = await run(
    process.execPath,
    [CLI, FIXTURE, "--alt", "Repository"],
    {
      ...process.env,
      GITHUB_ATTACHMENTS_TOKEN: "process-token",
      GITHUB_ATTACHMENTS_URL: serviceUrl,
    },
    repository,
  );

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, EXPECTED_MARKDOWN);
});

test("CLI reads the user-level service profile", async (context) => {
  const serviceUrl = await startServer(context, { alt: "User config", token: "user-token" });
  const repository = await temporaryRepository(context);
  const configHome = join(repository, "config");
  await mkdir(join(configHome, "github-pr-attachments"), { recursive: true });
  await writeFile(join(configHome, "github-pr-attachments", "token"), "user-token\n");
  await writeFile(join(configHome, "github-pr-attachments", "url"), `${serviceUrl}\n`);
  const environment = withoutAttachmentConfiguration();
  environment.XDG_CONFIG_HOME = configHome;

  const result = await run(
    process.execPath,
    [CLI, FIXTURE, "--alt", "User config"],
    environment,
    repository,
  );

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, EXPECTED_MARKDOWN);
});

test("skill uploader uses the repository override", async (context) => {
  const serviceUrl = await startServer(context, { alt: "Skill", token: "skill-repo-token" });
  const repository = await temporaryRepository(context);
  await writeFile(
    join(repository, ".env"),
    "GITHUB_ATTACHMENTS_TOKEN=skill-repo-token\nGITHUB_ATTACHMENTS_URL=http://127.0.0.1:1\n",
  );

  const result = await run(
    SKILL_UPLOADER,
    [FIXTURE, "Skill"],
    {
      ...process.env,
      GITHUB_ATTACHMENTS_TOKEN: "process-token",
      GITHUB_ATTACHMENTS_URL: serviceUrl,
    },
    repository,
  );

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, EXPECTED_MARKDOWN);
});

test("skill uploader reads the user-level service profile", async (context) => {
  const serviceUrl = await startServer(context, { alt: "Skill user", token: "skill-user-token" });
  const repository = await temporaryRepository(context);
  const configHome = join(repository, "config");
  await mkdir(join(configHome, "github-pr-attachments"), { recursive: true });
  await writeFile(join(configHome, "github-pr-attachments", "token"), "skill-user-token\n");
  await writeFile(join(configHome, "github-pr-attachments", "url"), `${serviceUrl}\n`);
  const environment = withoutAttachmentConfiguration();
  environment.XDG_CONFIG_HOME = configHome;

  const result = await run(SKILL_UPLOADER, [FIXTURE, "Skill user"], environment, repository);

  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, EXPECTED_MARKDOWN);
});

async function startServer(context, expected) {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/attachments");
    assert.equal(request.headers.authorization, `Bearer ${expected.token}`);
    assert.equal(request.headers["x-filename"], "cli-fixture.txt");
    assert.equal(request.headers["x-alt-text"], expected.alt);
    assert.equal(request.headers["content-type"], "text/plain");

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    assert.equal(Buffer.concat(chunks).toString("utf8"), "attachment CLI fixture\n");

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ markdown: EXPECTED_MARKDOWN.trim() }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function temporaryRepository(context) {
  const temporaryRoot = resolve(".github-attachments", "node-tests");
  await mkdir(temporaryRoot, { recursive: true });
  const repository = await mkdtemp(join(temporaryRoot, "repository-"));
  await writeFile(join(repository, ".git"), "gitdir: test\n");
  context.after(() => rm(repository, { force: true, recursive: true }));
  return repository;
}

function withoutAttachmentConfiguration() {
  const environment = { ...process.env };
  delete environment.GITHUB_ATTACHMENTS_TOKEN;
  delete environment.GITHUB_ATTACHMENTS_URL;
  return environment;
}

async function run(command, arguments_, environment, cwd = process.cwd()) {
  const child = spawn(command, arguments_, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode] = await once(child, "exit");
  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}
