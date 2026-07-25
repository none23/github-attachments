import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import process from "node:process";

export async function loadConfiguration() {
  const repositoryRoot = await findRepositoryRoot(process.cwd());
  const repository = parseDotEnv(await readOptionalFile(join(repositoryRoot, ".env")));
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const serviceConfig = join(configHome, "github-pr-attachments");
  const userToken = (await readOptionalFile(join(serviceConfig, "token"))).trim();
  const userUrl = (await readOptionalFile(join(serviceConfig, "url"))).trim();

  const token = firstValue(
    repository.GITHUB_ATTACHMENTS_TOKEN,
    process.env.GITHUB_ATTACHMENTS_TOKEN,
    userToken,
  );
  if (token === undefined) {
    throw new Error(
      "No upload token found in repository .env, GITHUB_ATTACHMENTS_TOKEN, or ~/.config/github-pr-attachments/token",
    );
  }

  const serviceUrl = firstValue(process.env.GITHUB_ATTACHMENTS_URL, userUrl);
  if (serviceUrl === undefined) {
    throw new Error(
      "No service URL found in GITHUB_ATTACHMENTS_URL or ~/.config/github-pr-attachments/url",
    );
  }

  return {
    serviceUrl: serviceUrl.replace(/\/$/, ""),
    token,
  };
}

export function parseDotEnv(contents) {
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

async function findRepositoryRoot(start) {
  let directory = start;
  while (true) {
    if (await exists(join(directory, ".git"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) {
      return start;
    }
    directory = parent;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

function firstValue(...values) {
  return values.map((value) => value?.trim()).find(Boolean);
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
