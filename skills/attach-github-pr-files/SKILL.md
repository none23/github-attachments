---
name: attach-github-pr-files
description: Upload local images or files and embed them in a GitHub pull request body or comment. Use when a PR needs a screenshot, log, PDF, or other attachment that GitHub CLI, Codex, or Claude Code cannot upload directly.
---

Run this skill's `scripts/upload.sh FILE [ALT]`; paste its Markdown output into the PR.

Resolve credentials from repository `.env`, environment, then user config. Give images meaningful alt text.

Never upload secrets: anyone with the URL can read the file until it expires.
