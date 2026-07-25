#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_CONFIG = join(PROJECT_ROOT, "wrangler.jsonc");
const DEFAULT_CONFIG = join(PROJECT_ROOT, "wrangler.user.jsonc");
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const PREFIX_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]|\/(?!\/))*\/$/;

export function parseArguments(arguments_) {
  const options = {
    clientConfigDir: join(
      process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
      "github-pr-attachments",
    ),
    config: DEFAULT_CONFIG,
    createBucket: false,
    deployEnv: join(
      process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
      "github-pr-attachments",
      "deploy.env",
    ),
    retentionDays: 180,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--bucket":
        options.bucket = requiredValue(arguments_, ++index, argument);
        break;
      case "--client-config-dir":
        options.clientConfigDir = resolve(requiredValue(arguments_, ++index, argument));
        break;
      case "--config":
        options.config = resolve(requiredValue(arguments_, ++index, argument));
        break;
      case "--create-bucket":
        options.createBucket = true;
        break;
      case "--deploy-env":
        options.deployEnv = resolve(requiredValue(arguments_, ++index, argument));
        break;
      case "--prefix":
        options.prefix = requiredValue(arguments_, ++index, argument);
        break;
      case "--retention-days":
        options.retentionDays = Number(requiredValue(arguments_, ++index, argument));
        break;
      case "--worker":
        options.worker = requiredValue(arguments_, ++index, argument);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

export function validateOptions(options) {
  if (!NAME_PATTERN.test(options.worker ?? "")) {
    throw new Error("--worker must be a 3-63 character lowercase Cloudflare Worker name");
  }
  if (!NAME_PATTERN.test(options.bucket ?? "")) {
    throw new Error("--bucket must be a 3-63 character lowercase R2 bucket name");
  }
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new Error("--retention-days must be a positive integer");
  }
  if (dirname(options.config) !== PROJECT_ROOT) {
    throw new Error("--config must name a file in the project root");
  }

  return {
    ...options,
    prefix: normalizePrefix(options.prefix ?? `${options.worker}/objects/`),
  };
}

export function normalizePrefix(raw) {
  const prefix = raw.trim().endsWith("/") ? raw.trim() : `${raw.trim()}/`;
  if (
    prefix.length > 512 ||
    !PREFIX_PATTERN.test(prefix) ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("--prefix must be a safe R2 key prefix");
  }
  return prefix;
}

export function buildWranglerConfig(base, options) {
  return {
    ...base,
    name: options.worker,
    r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: options.bucket }],
    vars: {
      ...base.vars,
      OBJECT_PREFIX: options.prefix,
      RETENTION_DAYS: String(options.retentionDays),
    },
  };
}

export function parseEnvironment(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match === null) {
      continue;
    }
    const [, key, rawValue] = match;
    values[key] = unquote(rawValue);
  }
  return values;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = validateOptions(parsed);
  const base = JSON.parse(await readFile(BASE_CONFIG, "utf8"));
  const generated = buildWranglerConfig(base, options);
  await writeFile(options.config, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
  await chmod(options.config, 0o600);

  const deployFile = await readOptionalFile(options.deployEnv);
  const deploymentEnvironment = { ...parseEnvironment(deployFile), ...process.env };
  if (!deploymentEnvironment.CLOUDFLARE_API_TOKEN) {
    throw new Error(`CLOUDFLARE_API_TOKEN is required in the environment or ${options.deployEnv}`);
  }
  if (!deploymentEnvironment.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID is required in the environment or ${options.deployEnv}`);
  }

  process.stdout.write(`Configuration: ${options.config}\n`);
  process.stdout.write(`Worker: ${options.worker}\n`);
  process.stdout.write(`Bucket: ${options.bucket}\n`);
  process.stdout.write(`Object prefix: ${options.prefix}\n`);

  const bucket = runWrangler(
    ["r2", "bucket", "info", options.bucket, "--json"],
    deploymentEnvironment,
    false,
  );
  if (bucket.status !== 0) {
    if (!options.createBucket) {
      throw new Error(
        `R2 bucket ${options.bucket} is unavailable. Create it or pass --create-bucket.`,
      );
    }
    runWrangler(["r2", "bucket", "create", options.bucket], deploymentEnvironment);
  }

  const ruleId = `github-pr-attachments-${createHash("sha256")
    .update(options.prefix)
    .digest("hex")
    .slice(0, 12)}`;
  runWrangler(
    [
      "r2",
      "bucket",
      "lifecycle",
      "add",
      options.bucket,
      ruleId,
      options.prefix,
      "--expire-days",
      String(options.retentionDays),
      "--force",
    ],
    deploymentEnvironment,
  );

  const temporaryRoot = join(PROJECT_ROOT, ".github-attachments");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, "setup-"));
  const uploadToken = randomBytes(32).toString("base64url");
  const secretsFile = join(temporaryDirectory, "secrets.env");

  let deployment;
  try {
    await writeFile(secretsFile, `UPLOAD_TOKEN=${uploadToken}\n`, { mode: 0o600 });
    deployment = runWrangler(
      ["deploy", "--config", options.config, "--secrets-file", secretsFile, "--minify"],
      deploymentEnvironment,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const serviceUrl = deployment.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (serviceUrl === undefined) {
    throw new Error("Wrangler deployed the Worker but did not report its workers.dev URL");
  }

  await waitForHealth(serviceUrl);
  await writeClientProfile(options.clientConfigDir, serviceUrl, uploadToken);

  process.stdout.write(`Service URL: ${serviceUrl}\n`);
  process.stdout.write(`Client profile: ${options.clientConfigDir}\n`);
  process.stdout.write("Deployment is healthy and ready for uploads.\n");
}

function runWrangler(arguments_, environment, required = true) {
  const executable = join(
    PROJECT_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(executable, arguments_, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: environment,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (required || result.status === 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (required && result.status !== 0) {
    throw new Error(`Wrangler failed: ${arguments_.slice(0, 4).join(" ")}`);
  }
  return { output, status: result.status };
}

async function waitForHealth(serviceUrl) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${serviceUrl}/healthz`);
      const body = await response.json();
      if (response.ok && body.status === "ok") {
        return;
      }
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Worker health check failed: ${lastError?.message ?? "unknown error"}`);
}

async function writeClientProfile(directory, serviceUrl, uploadToken) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await atomicPrivateWrite(join(directory, "url"), `${serviceUrl}\n`);
  await atomicPrivateWrite(join(directory, "token"), `${uploadToken}\n`);
}

async function atomicPrivateWrite(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function usage() {
  return `Usage:
  npm run setup -- --worker NAME --bucket NAME [--create-bucket]

Options:
  --prefix PREFIX             R2 key prefix (default: WORKER/objects/)
  --retention-days DAYS      Lifecycle and service retention (default: 180)
  --client-config-dir PATH   Client profile directory
  --deploy-env PATH          Cloudflare deployment credential file
  --config PATH              Generated Wrangler config in the project root`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Setup failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
