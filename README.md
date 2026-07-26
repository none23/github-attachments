# GitHub PR Attachment Service

Give coding agents a reliable way to add screenshots, logs, PDFs, and other files to GitHub pull requests.

When an agent cannot use GitHub's browser-only attachment interface, this self-hosted service fills the gap. The agent uploads a local file, receives ready-to-paste Markdown, and adds it to a pull request through the normal GitHub API or CLI.

- Works with Codex, Claude Code, shell scripts, and other automated tools.
- Runs in your own Cloudflare account using a Worker and a private R2 bucket.
- Requires no GitHub credentials and never calls GitHub itself.
- Uses free-tier-conscious storage, request, and retention limits by default.

Attachment URLs are public to anyone who possesses them. Use the service only for nonsensitive files.

## Demo

[Demo PR #1](https://github.com/none23/github-attachments/pull/1) shows the complete workflow. The images in its description were created on two different machines and uploaded by an agent through this service—there was no manual GitHub attachment step.

## How it works

1. An agent runs the included upload skill or CLI with a local file.
2. Your Cloudflare Worker authenticates the upload and stores the file in private R2.
3. The service returns an opaque public URL and ready-to-paste Markdown.
4. The agent places that Markdown in the pull request body or a comment.

```text
Agent -> your Worker -> private R2
                         |
GitHub PR <--- Markdown URL
```

## Quick start

You need:

- A Cloudflare account with Workers and R2 available.
- Node.js 24 or later.
- A short-lived Cloudflare API token scoped to your account with:
  - Workers Scripts: Edit
  - Workers R2 Storage: Edit
  - Account Settings: Read

### 1. Deploy your service

```bash
git clone https://github.com/none23/github-attachments.git
cd github-attachments
npm ci
```

Save the Cloudflare deployment credential outside Git:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/github-pr-attachments"
mkdir -p "$config_dir"
chmod 700 "$config_dir"
$EDITOR "$config_dir/deploy.env"
chmod 600 "$config_dir/deploy.env"
```

`deploy.env` contains:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-short-lived-deployment-token
```

Create a private bucket and deploy the Worker:

```bash
npm run setup -- \
  --worker github-pr-attachments-yourname \
  --bucket github-pr-attachments-yourname \
  --create-bucket
```

Setup creates the bucket, lifecycle rule, Worker secret, and user-level upload profile. Once it succeeds, remove or revoke the Cloudflare deployment token unless this machine also needs to administer the service.

### 2. Install the agent skill and CLI

```bash
mkdir -p "$HOME/.codex/skills" "$HOME/.claude/skills"
ln -s "$PWD/skills/attach-github-pr-files" \
  "$HOME/.codex/skills/attach-github-pr-files"
ln -s "$PWD/skills/attach-github-pr-files" \
  "$HOME/.claude/skills/attach-github-pr-files"
npm link
```

The symlinks install the same skill for Codex and Claude Code without copying it.

### 3. Attach a file

Ask the agent to attach a file to a pull request, or use the CLI directly:

```bash
github-attach screenshot.png --alt "Settings after the change"
```

The command prints Markdown:

```markdown
![Settings after the change](https://your-worker.your-subdomain.workers.dev/a/.../screenshot.png)
```

Pass `--json` to receive the complete upload response. Diagnostics and errors go to standard error.

## Deployment options

Each deployment has one Worker, one upload token, and one statically bound R2 bucket. Upload requests cannot select or override the bucket.

To reuse an existing private bucket, omit `--create-bucket` and choose a unique prefix:

```bash
npm run setup -- \
  --worker github-pr-attachments-yourname \
  --bucket your-existing-private-bucket \
  --prefix github-pr-attachments-yourname/objects/
```

The default prefix is `<worker-name>/objects/`; the default retention is 180 days. Use `--prefix` and `--retention-days` to change them. Distinct prefixes allow multiple deployments to share one bucket safely.

Setup generates an ignored `wrangler.user.jsonc` and writes the runtime profile to:

```text
${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/url
${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/token
```

The upload token can use this service but cannot administer Cloudflare.

## Configuration reference

### Upload token

The CLI and agent skill use the first nonempty token in this order:

| Priority | Location | Scope |
| ---: | --- | --- |
| 1 | `GITHUB_ATTACHMENTS_TOKEN` in the repository-root `.env` | Repository override |
| 2 | `GITHUB_ATTACHMENTS_TOKEN` in the process environment | Process override |
| 3 | `${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/token` | User default |

For a repository-specific token:

```dotenv
GITHUB_ATTACHMENTS_TOKEN=repository-specific-token
```

Keep the repository `.env` uncommitted. User profile files and `.env` are parsed as data rather than sourced as shell code.

### Service URL

The service URL is required and resolves separately:

| Priority | Location | Scope |
| ---: | --- | --- |
| 1 | `GITHUB_ATTACHMENTS_URL` in the process environment | Process override |
| 2 | `${XDG_CONFIG_HOME:-~/.config}/github-pr-attachments/url` | User deployment |

Repository `.env` cannot redirect a user-level token to another service, and there is no shared-service fallback.

### HTTP API

The raw API accepts the file body directly:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  -H "X-Filename: screenshot.png" \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png \
  "$GITHUB_ATTACHMENTS_URL/v1/attachments"
```

See [openapi.yaml](openapi.yaml) for the complete contract.

## Technical overview

```text
Agent -> authenticated Worker -> atomic quota reservation -> private R2
GitHub -> opaque public URL -> Worker security headers -> private R2
```

- The Worker authenticates mutations, validates requests, streams file bodies, and generates Markdown.
- R2 remains private; downloads pass through the Worker.
- A SQLite-backed Durable Object coordinates the service-wide quota.
- Durable Object alarms clean up expired objects and abandoned reservations.
- A prefix-scoped R2 lifecycle rule provides expiration defense in depth.

PNG, JPEG, GIF, and WebP responses can render inline. Other media types are served as downloads with `nosniff` and a restrictive content security policy.

## Default limits

| Limit | Default |
| --- | ---: |
| Stored data | 8 GB |
| Objects | 50,000 |
| Raster image size | 10 MB |
| Other file size | 25 MB |
| Upload attempts per day | 1,000 |
| Upload attempts per month | 100,000 |
| Retention | 180 days |

Reservations are atomic under concurrent uploads. Failed attempts still count toward daily and monthly operation limits.

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

Cloudflare budget alerts provide additional visibility but do not stop spending. The application limits, private bucket, and platform request limits are the primary cost boundaries.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run types
npm run check
npm run dev
```

`npm run check` runs formatting and lint checks, generated binding drift checks, strict TypeScript checks, Workers-runtime integration tests, and CLI/setup tests.

## Security model

- A random 256-bit bearer token protects upload, delete, and quota routes.
- Secret comparison uses Cloudflare's constant-time Web Crypto operation.
- Public IDs are cryptographically random UUIDs and cannot be listed through the service.
- User filenames never become R2 keys and cannot set response headers.
- Public URLs are capability URLs, not private-repository authorization.
- The service does not scan downloads for malware.

## Design and license

See [DESIGN.md](DESIGN.md) for the original proposal and design rationale.

This project is available under the [MIT License](LICENSE).
