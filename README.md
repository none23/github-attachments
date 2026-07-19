# GitHub PR Attachment Service

A private upload service for agents that need to place files in GitHub pull-request Markdown. It runs on Cloudflare Workers, stores bytes in a private R2 bucket, and returns an opaque public URL plus ready-to-paste Markdown.

The service does not receive GitHub credentials and does not call GitHub. Anyone possessing an attachment URL can retrieve it, so uploads must be nonsensitive.

## Agent usage

Configure credentials once at the user level, then expose the included CLI:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/github-pr-attachments"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
$EDITOR "$config_dir/token"
chmod 600 "$config_dir/token"

npm install
npm link
github-attach screenshot.png --alt "Settings after the change"
```

The token file contains only the raw token, with no variable name or quotes.

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

`GITHUB_ATTACHMENTS_URL` can be set only in the process environment and otherwise defaults to `https://github-pr-attachments.none23.workers.dev`. Repository `.env` cannot redirect a user-level token to another service. The user token file is not parsed as shell code, and repository `.env` files are read as data rather than sourced.

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

## Initial deployment

Authenticate Wrangler first:

```bash
npx wrangler login
```

Create the dedicated private bucket and its lifecycle rule:

```bash
npx wrangler r2 bucket create github-pr-attachments
npx wrangler r2 bucket lifecycle add \
  github-pr-attachments expire-attachments objects/ \
  --expire-days 180 --force
```

Generate a random token, save it somewhere private, and set the Worker secret through Wrangler's interactive prompt:

```bash
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

Never commit `.dev.vars`, bearer tokens, or generated credential files.

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
