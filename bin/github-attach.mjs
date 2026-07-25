#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import process from "node:process";
import { loadConfiguration } from "./config.mjs";

const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".log", "text/plain"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { serviceUrl, token } = await loadConfiguration();
  const bytes = await readFile(options.file);
  const filename = basename(options.file);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-length": String(bytes.byteLength),
    "content-type":
      CONTENT_TYPES.get(extname(filename).toLowerCase()) ?? "application/octet-stream",
    "x-filename": filename,
  };
  if (options.alt !== undefined) {
    headers["x-alt-text"] = options.alt;
  }

  const response = await fetch(`${serviceUrl}/v1/attachments`, {
    method: "POST",
    headers,
    body: bytes,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}): ${responseText}`);
  }

  const result = JSON.parse(responseText);
  if (typeof result.markdown !== "string") {
    throw new Error("Upload response did not contain Markdown");
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.markdown}\n`,
  );
}

function parseArguments(arguments_) {
  const options = { alt: undefined, file: undefined, help: false, json: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--alt") {
      const alt = arguments_[index + 1];
      if (alt === undefined) {
        fail("--alt requires a value");
      }
      options.alt = alt;
      index += 1;
    } else if (argument?.startsWith("-")) {
      fail(`Unknown option: ${argument}`);
    } else if (options.file === undefined) {
      options.file = argument;
    } else {
      fail("Only one file may be uploaded at a time");
    }
  }

  if (!options.help && options.file === undefined) {
    fail("A file path is required");
  }
  return options;
}

function fail(message) {
  throw new Error(`${message}\n\n${usage()}`);
}

function usage() {
  return `Usage: github-attach <file> [--alt <text>] [--json]

Configuration:
  .env                                      Repository override
  GITHUB_ATTACHMENTS_TOKEN                  Environment override
  ~/.config/github-pr-attachments/token     User token
  ~/.config/github-pr-attachments/url       User service URL`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
