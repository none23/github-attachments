# GitHub PR Attachment Service

Status: Proposed design  
Last updated: 2026-07-18

## Summary

GitHub supports attaching files to pull requests through its web interface, but its documented REST API accepts Markdown bodies without providing a corresponding attachment-upload endpoint. This service fills that gap for programmatic agents such as Codex and Claude Code.

An agent uploads a file with one authenticated HTTP request. The service returns a stable URL and ready-to-paste Markdown, after which the agent creates or updates the pull request through the normal GitHub API. The service never receives or stores GitHub credentials.

The proposed deployment uses a Cloudflare Worker, a private R2 bucket, and a SQLite-backed Durable Object. It is designed to remain within Cloudflare's free allowances and to fail closed before exceeding its configured capacity.

## Goals

- Let command-line agents attach screenshots, logs, archives, PDFs, and similar artifacts to GitHub pull requests.
- Require only `curl` or a small dependency-light helper command.
- Return Markdown that can be inserted directly into a pull-request body or comment.
- Avoid GitHub tokens, OAuth, GitHub Apps, or undocumented GitHub endpoints.
- Make uploaded objects unlistable and impractical to guess.
- Enforce storage and operation quotas before Cloudflare charges can accrue.
- Keep deployment and maintenance small enough for one person.

## Non-goals

- Reproducing GitHub's native `user-attachments` URLs.
- Making externally hosted files inherit a private repository's GitHub permissions.
- Providing a general-purpose public file-sharing service.
- Providing malware scanning in the initial version.
- Supporting multi-gigabyte or resumable uploads.
- Providing a graphical administration interface.

## Architecture

```text
Codex / Claude Code
        |
        | POST file + bearer token
        v
Cloudflare Worker --------> Quota Durable Object
        |                    reserves bytes and operations
        |
        +------------------> Private R2 bucket
                                  |
GitHub PR Markdown                | GET through opaque URL
        |                         |
        +------------> Cloudflare Worker --------> file
```

### Components

#### Cloudflare Worker

The Worker owns the public API. It authenticates uploads, validates metadata, reserves quota, streams objects to R2, and serves public downloads.

All downloads pass through the Worker. Direct public access to the R2 bucket remains disabled so traffic cannot bypass the Worker's request limits or the service's response-header policy.

#### R2 bucket

R2 stores file bodies and a small amount of object metadata:

- Original sanitized filename
- Media type
- Upload timestamp
- Expiration timestamp
- Inline-versus-download disposition

R2 object keys are generated identifiers rather than user-supplied filenames. A representative key is `objects/019b7c...`; filenames appear only in metadata and public URLs.

#### Quota Durable Object

A single SQLite-backed Durable Object serializes quota changes and tracks:

- Reserved and stored bytes
- Object count
- Upload count for the current calendar month
- Per-token daily upload count
- Pending reservations

The Worker reserves capacity before writing to R2 and releases the reservation if the upload fails. Authenticated deletion releases capacity immediately. A scheduled reconciliation corrects conservative counters after R2 lifecycle deletions.

## Agent workflow

An agent uploads raw bytes:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  -H "X-Filename: screenshot.png" \
  -H "Content-Type: image/png" \
  --data-binary @screenshot.png \
  "$GITHUB_ATTACHMENTS_URL/v1/attachments"
```

The service responds:

```json
{
  "id": "019b7c...",
  "filename": "screenshot.png",
  "contentType": "image/png",
  "size": 184231,
  "url": "https://service.workers.dev/a/019b7c.../screenshot.png",
  "markdown": "![screenshot](https://service.workers.dev/a/019b7c.../screenshot.png)",
  "expiresAt": "2027-01-14T12:00:00Z"
}
```

The repository will also provide a helper that prints only Markdown to standard output:

```bash
github-attach screenshot.png --alt "Settings before the change"
```

Diagnostics go to standard error, allowing an agent to capture the Markdown safely. This one-command pattern takes inspiration from self-hosted tools such as [transfer.sh](https://github.com/dutchcoders/transfer.sh), while the implementation remains purpose-built for pull-request attachments.

## HTTP API

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `POST /v1/attachments` | Bearer token | Upload raw file bytes |
| `GET /a/{id}/{filename}` | Opaque URL | Render or download an attachment |
| `HEAD /a/{id}/{filename}` | Opaque URL | Retrieve attachment metadata |
| `DELETE /v1/attachments/{id}` | Bearer token | Delete an erroneous upload |
| `GET /v1/quota` | Bearer token | Report current quota consumption |
| `GET /healthz` | None | Check deployment health |

### Upload request

Required headers:

- `Authorization: Bearer <token>`
- `Content-Length: <bytes>`
- `X-Filename: <display filename>`

Optional headers:

- `Content-Type`; defaults to `application/octet-stream`
- `X-Alt-Text`; used when generating image Markdown

`Content-Length` is mandatory so the service can reject an upload before reading its body if insufficient quota remains.

### Upload response

Successful uploads return `201 Created` and JSON containing:

- Generated attachment ID
- Sanitized filename
- Stored byte count
- Effective media type
- Public URL
- Ready-to-paste Markdown
- Expiration timestamp
- R2 entity tag

Images receive `![alt](url)` Markdown. Other files receive `[filename](url)` Markdown. Markdown-special characters in filenames and alt text are escaped by the service.

### Errors

Errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "The attachment storage quota has been reached."
  }
}
```

Representative status codes:

- `400` for invalid filename or metadata
- `401` for missing or invalid credentials
- `411` for missing `Content-Length`
- `413` for a file exceeding the configured limit
- `429` for a daily or monthly operation limit
- `507` for exhausted storage capacity

## Limits and retention

Proposed initial service limits:

| Limit | Value |
| --- | ---: |
| Maximum stored bytes | 8 GB |
| Maximum objects | 50,000 |
| Maximum file size | 25 MB |
| Default image size limit | 10 MB |
| Maximum uploads per month | 100,000 |
| Default retention | 180 days |

The object lifecycle expires files automatically after the retention period. R2 lifecycle deletion may be delayed, so quota is accounted conservatively until scheduled reconciliation observes the deletion.

Permanent retention is deliberately not the default. It would eventually exhaust the fixed free storage allowance and require manual deletion or paid storage.

## Security and privacy

### Upload authentication

- Upload, deletion, and quota endpoints require a random 256-bit bearer token.
- Tokens are stored as Cloudflare secrets and never committed to the repository.
- Agents receive the token through `GITHUB_ATTACHMENTS_TOKEN`.
- Tokens and authorization headers are never included in application logs.
- The first version supports one owner token; scoped or independently revocable tokens can be added later.

### Public attachment URLs

- Each URL contains an identifier with at least 128 bits of cryptographic randomness.
- The service exposes no listing, search, or sequential identifier endpoint.
- The filename portion of the URL is cosmetic and is not used as the storage key.
- Possession of the URL grants access to the file.

Opaque URLs are public capability URLs, not access control equivalent to a private GitHub repository. They are suitable for nonsensitive screenshots and build artifacts. Secrets, customer data, private source archives, and other confidential files must not be uploaded.

### Content handling

- Only PNG, JPEG, GIF, and WebP are served with an inline disposition.
- SVG, HTML, PDFs, archives, logs, binaries, and all unknown types are served as downloads.
- User-controlled values cannot set arbitrary response headers.
- Filenames are length-limited and stripped of control characters and path separators.
- Download responses set `X-Content-Type-Options: nosniff`.
- The attachment origin sets no cookies and uses a restrictive Content Security Policy.
- Cross-origin reads are allowed where needed for GitHub image rendering.

The service does not claim that uploaded downloads are safe. Since upload access is private rather than public, malware scanning is deferred unless a credible free scanning mechanism becomes available.

## Free-tier and cost controls

As of 2026-07-18, Cloudflare documents the following relevant free allowances:

- 100,000 Worker requests per day.
- 10 GB-month of Standard R2 storage.
- 1 million R2 Class A operations per month.
- 10 million R2 Class B operations per month.
- No R2 internet egress charge.

Sources: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The service stays below those allowances through several independent controls:

1. Stored bytes are capped at 8 GB, leaving headroom below the 10 GB-month storage allowance.
2. Upload operations are capped well below the R2 Class A allowance.
3. The R2 bucket has no public endpoint, so every read is bounded by the Worker's daily request limit.
4. All objects use Standard storage. R2's free allowance does not apply to Infrequent Access storage.
5. The Durable Object atomically prevents concurrent uploads from overcommitting capacity.
6. Lifecycle rules reclaim expired storage.
7. Exceeding an application quota fails closed instead of accepting the upload.

Cloudflare budget alerts should also be enabled, but they are informational and do not pause or cap usage. They are an additional notification mechanism, not a cost-control boundary. See [Cloudflare's budget-alert documentation](https://developers.cloudflare.com/billing/manage/budget-alerts/).

The strongest zero-cost setup uses a dedicated Cloudflare account. Free allowances are account-wide, so unrelated Workers, R2 buckets, or direct R2 credentials could otherwise consume allowance outside this service's controls.

## Why not direct presigned R2 uploads?

R2 supports presigned upload URLs, but they add S3 signature handling and create another path that must participate in quota enforcement. Presigned URLs also use the R2 S3 API hostname rather than a custom domain.

For files capped at 25 MB, streaming the request through the Worker is simpler, keeps the bearer-token API easy for agents, and ensures every accepted upload has already reserved capacity. Presigned or multipart uploads can be introduced later if the file-size requirement changes. See [Cloudflare's presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## Implementation plan

### Phase 1: Service foundation

- Create a TypeScript Cloudflare Worker using native platform APIs.
- Add the R2 binding and SQLite Durable Object migration.
- Implement bearer authentication and structured errors.
- Implement upload, download, head, delete, quota, and health routes.
- Add object metadata and safe response-header handling.

### Phase 2: Cost and lifecycle enforcement

- Implement atomic byte and operation reservations.
- Roll reservations back on failed R2 writes.
- Configure the R2 lifecycle rule.
- Add scheduled quota reconciliation.
- Add daily and monthly upload counters.

### Phase 3: Agent experience

- Add the `github-attach` helper.
- Add an OpenAPI document.
- Document environment-variable setup for Codex and Claude Code.
- Provide `AGENTS.md` and `CLAUDE.md` instruction snippets.

### Phase 4: Verification and deployment

- Unit-test authentication, input validation, Markdown escaping, and headers.
- Integration-test upload, retrieval, deletion, expiration, and quota rollback.
- Test concurrent uploads against the capacity boundary.
- Deploy to a free `workers.dev` hostname.
- Run a smoke test using a small image and a downloadable text file.
- Enable Cloudflare billing alerts as defense in depth.

## Initial technology choices

- TypeScript
- Cloudflare Workers module syntax
- Native Worker request routing, without a web framework
- Cloudflare R2 Standard storage
- SQLite-backed Durable Object
- Wrangler for local development and deployment
- Vitest with the Cloudflare Workers test integration
- A dependency-light shell or Node.js agent helper

## Open decisions

The following decisions should be confirmed before implementation:

1. **Private repository use:** Are public-but-unguessable URLs acceptable for files mentioned in private pull requests? Recommended default: allow them only for explicitly nonsensitive files.
2. **Retention:** Is 180-day expiration acceptable, or must attachments be permanent? Recommended default: 180 days with explicit expiration in every response.
3. **Cloudflare account:** Can the service use a dedicated Cloudflare Free account? Recommended default: yes, to isolate the account-wide free allowances.
4. **Hostname:** Is the free `workers.dev` hostname sufficient initially? Recommended default: yes, with an optional custom domain later.

## References

- [GitHub: Attaching files](https://docs.github.com/en/enterprise-cloud@latest/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [transfer.sh source repository](https://github.com/dutchcoders/transfer.sh)
