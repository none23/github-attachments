# GitHub PR Attachment Service

A private upload service for agents that need to place files in GitHub pull-request Markdown. It runs on Cloudflare Workers, stores bytes in a private R2 bucket, and returns an opaque public URL plus ready-to-paste Markdown.

The service does not receive GitHub credentials and does not call GitHub. Anyone possessing an attachment URL can retrieve it, so uploads must be nonsensitive.

## Agent usage

Deploy the service once or configure an existing profile, then expose the included CLI:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/github-pr-attachments"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
$EDITOR "$config_dir/token"
$EDITOR "$config_dir/url"
chmod 600 "$config_dir/token"
chmod 600 "$config_dir/url"

npm install
npm link
github-attach screenshot.png --alt "Settings after the change"
```

The `token` file contains only the raw upload token. The `url` file contains the Worker origin, such as `https://github-pr-attachments.example.workers.dev`. Neither file uses variable names or quotes. `npm run setup` creates both files automatically.

### Credential resolution

The CLI and bundled agent skill use the first nonempty token in this order:

| Priority | Location | Scope |
| ---: | --- | --- |
| 1 | `GITHUB_ATTACHMENTS_TOKEN` in the repository-root `.env` | Current repository override |
| 2 | `GITHUB_ATTACHMENTS_TOKEN` in the process environment | Current process override |
| 3 | `${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/token` | User-level default |

To override the user token for one repository, add this to that repository's `.env`:

```dotenv
GITHUB_ATTACHMENTS_TOKEN=repository-specific-token
```

The repository `.env` must remain uncommitted. This repository ignores `.env` and `.env.*` by default; copy the same rules into repositories that do not already ignore them. Use `.env.example` for placeholder documentation only—never put a real token in it.

The service URL resolves separately:

| Priority | Location | Scope |
| ---: | --- | --- |
| 1 | `GITHUB_ATTACHMENTS_URL` in the process environment | Current process override |
| 2 | `${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/url` | User-level deployment |
| 3 | `https://github-pr-attachments.none23.workers.dev` | Backward-compatible default |

Repository `.env` cannot redirect a user-level token to another service. User profile files and repository `.env` are parsed as data, never sourced as shell code.

The CLI prints only Markdown by default:

```markdown
![Settings after the change](https://github-pr-attachments.none23.workers.dev/a/.../screenshot.png)
```

Pass `--json` to receive the complete upload response. Diagnostics and errors go to standard error.

The raw API is equally small:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  -H "X-Filename: screenshot.png" \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png \
  "$GITHUB_ATTACHMENTS_URL/v1/attachments"
```

See [openapi.yaml](openapi.yaml) for the complete contract.

## Architecture

```text
Agent -> authenticated Worker -> atomic quota reservation -> private R2
GitHub -> opaque public URL -> Worker security headers -> private R2
```

- The Worker validates requests, authenticates mutations, generates Markdown, and streams bodies.
- R2 remains private; there is no `r2.dev` or public bucket endpoint.
- One SQLite-backed Durable Object is the coordination atom for this single service quota.
- Durable Object alarms delete expired objects and abandoned reservations.
- An R2 lifecycle rule provides expiration defense in depth.

Only PNG, JPEG, GIF, and WebP responses are rendered inline. Every other media type is sent with an attachment disposition, `nosniff`, and a restrictive content security policy.

## Limits

| Limit | Default |
| --- | ---: |
| Stored data | 8 GB |
| Objects | 50,000 |
| Raster image size | 10 MB |
| Other file size | 25 MB |
| Upload attempts per day | 1,000 |
| Upload attempts per month | 100,000 |
| Retention | 180 days |

Reservations are atomic, including under concurrent uploads. Failed attempts still count toward daily and monthly operation limits, which keeps abuse accounting conservative.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run types
npm run check
npm run dev
```

`npm run check` runs Biome, generated binding drift checks, strict TypeScript checks, Workers-runtime integration tests, and the CLI integration test.

## Deploy your own service

Each deployment has one Worker, one upload token, and one statically bound R2 bucket. Upload requests cannot choose or override the bucket.

Install dependencies, then create a least-privilege Cloudflare API token with these account permissions:

- Workers Scripts: Edit
- Workers R2 Storage: Edit
- Account Settings: Read

Limit it to the target account. A short expiration and client-IP restriction further reduce its blast radius when appropriate. Save it outside Git:

```bash
deploy_config="${XDG_CONFIG_HOME:-$HOME/.config}/github-pr-attachments"
mkdir -p "$deploy_config"
chmod 700 "$deploy_config"
$EDITOR "$deploy_config/deploy.env"
chmod 600 "$deploy_config/deploy.env"
```

`deploy.env` contains:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-deployment-token
```

Create a new private bucket and deploy:

```bash
npm install
npm run setup -- \
  --worker github-pr-attachments-yourname \
  --bucket github-pr-attachments-yourname \
  --create-bucket
```

To reuse an existing private bucket, omit `--create-bucket`:

```bash
npm run setup -- \
  --worker github-pr-attachments-yourname \
  --bucket your-existing-private-bucket \
  --prefix github-pr-attachments-yourname/objects/
```

The setup command:

1. Verifies or creates the named bucket.
2. Adds a prefix-scoped R2 lifecycle rule.
3. Generates `wrangler.user.jsonc` with the selected Worker, bucket, prefix, and retention.
4. Generates a 256-bit upload token and deploys it as a Worker secret.
5. waits for `/healthz`, then writes the user-level `url` and `token` profile.

The default prefix is `<worker-name>/objects/`; the default retention is 180 days. Use `--prefix` and `--retention-days` to change them. Prefixes let multiple deployments safely share one bucket, provided every deployment uses a distinct prefix. `wrangler.user.jsonc`, `.env*`, `.dev.vars`, and `.github-attachments/` are ignored by Git.

The Cloudflare API token is needed only for provisioning and later redeployment. Remove or revoke it after setup if the machine should retain upload access but not deployment access. The user-level `token` is deliberately separate: it can upload through this service but cannot administer Cloudflare.

## Operations

Check health and quota:

```bash
curl "$GITHUB_ATTACHMENTS_URL/healthz"
curl --fail-with-body \
  -H "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  "$GITHUB_ATTACHMENTS_URL/v1/quota"
```

Delete an attachment:

```bash
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  "$GITHUB_ATTACHMENTS_URL/v1/attachments/$ATTACHMENT_ID"
```

Cloudflare budget alerts should be enabled as defense in depth. They do not stop spending; the application limits, private R2 bucket, and Workers Free request ceiling are the cost boundaries. A dedicated Cloudflare account prevents unrelated usage from consuming the same allowances.

## Security model

- A 256-bit bearer token protects upload, delete, and quota routes.
- Secret comparison uses Cloudflare's constant-time Web Crypto operation.
- Public IDs are cryptographically random UUIDs and cannot be listed through the service.
- User filenames never become R2 keys and cannot set response headers.
- Public URLs are capability URLs, not private-repository authorization.
- The service does not scan downloads for malware.

## Design

See [DESIGN.md](DESIGN.md) for the original proposal and design rationale.
