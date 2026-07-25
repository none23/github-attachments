---
name: attach-github-pr-files
description: Upload local images or files and embed them in a GitHub pull request body or comment. Use when a PR needs a screenshot, log, PDF, or other attachment that GitHub CLI, Codex, or Claude Code cannot upload directly.
---

Run `scripts/upload.sh FILE [ALT]` and paste its Markdown output into the PR. Give images meaningful alt text. Never upload secrets; URLs are public until expiration.
