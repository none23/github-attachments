# GitHub PR Attachment Service

A private upload service for agents that need to place files in GitHub pull-request Markdown. It runs on Cloudflare Workers, stores bytes in a private R2 bucket, and returns an opaque public URL plus ready-to-paste Markdown.

The service does not receive GitHub credentials and does not call GitHub. Anyone possessing an attachment URL can retrieve it, so uploads must be nonsensitive.

## Agent usage

Install dependencies and expose the included CLI:

```bash
npm install
npm link
export GITHUB_ATTACHMENTS_URL=https://github-pr-attachments.none23.workers.dev
export GITHUB_ATTACHMENTS_TOKEN='your-upload-token'
github-attach screenshot.png --alt "Settings after the change"
```

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

