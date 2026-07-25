import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWranglerConfig,
  lifecycleRuleStatus,
  normalizePrefix,
  parseArguments,
  parseEnvironment,
  validateOptions,
} from "../scripts/setup.mjs";

test("setup builds an isolated Worker and R2 binding", () => {
  const options = validateOptions(
    parseArguments([
      "--worker",
      "github-attachments-alice",
      "--bucket",
      "alice-attachments",
      "--prefix",
      "alice/pr-files",
      "--retention-days",
      "30",
    ]),
  );
  const base = {
    name: "original",
    main: "src/index.ts",
    r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: "original" }],
    vars: { OBJECT_PREFIX: "objects/", RETENTION_DAYS: "180", OTHER: "unchanged" },
  };

  const generated = buildWranglerConfig(base, options);

  assert.equal(generated.name, "github-attachments-alice");
  assert.deepEqual(generated.r2_buckets, [
    { binding: "ATTACHMENTS", bucket_name: "alice-attachments" },
  ]);
  assert.equal(generated.vars.OBJECT_PREFIX, "alice/pr-files/");
  assert.equal(generated.vars.RETENTION_DAYS, "30");
  assert.equal(generated.vars.OTHER, "unchanged");
  assert.equal(generated.main, "src/index.ts");
  assert.equal(base.name, "original");
});

test("setup validates names, prefixes, and retention", () => {
  assert.equal(normalizePrefix("user/objects"), "user/objects/");
  assert.throws(() => normalizePrefix("../objects"), /safe R2 key prefix/);
  assert.throws(() => normalizePrefix("user//objects"), /safe R2 key prefix/);
  assert.throws(
    () => validateOptions(parseArguments(["--worker", "Bad", "--bucket", "valid-bucket"])),
    /--worker/,
  );
  assert.throws(
    () =>
      validateOptions(
        parseArguments([
          "--worker",
          "valid-worker",
          "--bucket",
          "valid-bucket",
          "--retention-days",
          "0",
        ]),
      ),
    /--retention-days/,
  );
});

test("deployment credentials are parsed as data", () => {
  assert.deepEqual(
    parseEnvironment(
      "CLOUDFLARE_ACCOUNT_ID=account\nexport CLOUDFLARE_API_TOKEN='token value'\nignored\n",
    ),
    {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token value",
    },
  );
});

test("setup recognizes matching and conflicting lifecycle rules", () => {
  const output = `name:     attachment-rule
enabled:  Yes
prefix:   user/objects/
action:   Expire objects after 180 days
`;

  assert.equal(lifecycleRuleStatus(output, "attachment-rule", "user/objects/", 180), "matching");
  assert.equal(lifecycleRuleStatus(output, "attachment-rule", "user/objects/", 30), "conflicting");
  assert.equal(lifecycleRuleStatus(output, "other-rule", "user/objects/", 180), "missing");
});
