#!/bin/sh
set -eu

file=${1:?"usage: upload.sh FILE [ALT]"}
alt=${2-}
: "${GITHUB_ATTACHMENTS_TOKEN:?GITHUB_ATTACHMENTS_TOKEN is required}"
test -f "$file"

output=$(mktemp)
trap 'rm -f "$output"' EXIT HUP INT TERM

set -- \
  --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $GITHUB_ATTACHMENTS_TOKEN" \
  --header "X-Filename: $(basename "$file")" \
  --header "Content-Type: $(file --brief --mime-type -- "$file")" \
  --data-binary "@$file" \
  --output "$output"
[ -z "$alt" ] || set -- "$@" --header "X-Alt-Text: $alt"

if ! curl "$@" https://github-pr-attachments.none23.workers.dev/v1/attachments; then
  cat "$output" >&2
  exit 1
fi

node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1]));if(typeof x.markdown!=="string")throw Error("invalid response");console.log(x.markdown)' "$output"
