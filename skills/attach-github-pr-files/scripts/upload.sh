#!/bin/sh
set -eu

file=${1:?"usage: upload.sh FILE [ALT]"}
alt=${2-}
test -f "$file"

find_repository_root() {
  directory=$PWD
  while [ "$directory" != / ]; do
    if [ -e "$directory/.git" ]; then
      printf '%s\n' "$directory"
      return
    fi
    directory=${directory%/*}
    [ -n "$directory" ] || directory=/
  done
  printf '%s\n' "$PWD"
}

read_env_value() {
  key=$1
  env_file=$2
  [ -r "$env_file" ] || return 0
  awk -v wanted="$key" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" wanted "[[:space:]]*=" {
      sub("^[[:space:]]*(export[[:space:]]+)?" wanted "[[:space:]]*=[[:space:]]*", "")
      sub("[[:space:]]*$", "")
      print
      exit
    }
  ' "$env_file"
}

user_config_root=${XDG_CONFIG_HOME:-"${HOME:?HOME is required}/.config"}
token_file=$user_config_root/github-pr-attachments/token
url_file=$user_config_root/github-pr-attachments/url
token=
[ ! -r "$token_file" ] || token=$(sed -n '1p' "$token_file")
[ -z "${GITHUB_ATTACHMENTS_TOKEN-}" ] || token=$GITHUB_ATTACHMENTS_TOKEN
service_url=
[ ! -r "$url_file" ] || service_url=$(sed -n '1p' "$url_file")
[ -z "${GITHUB_ATTACHMENTS_URL-}" ] || service_url=$GITHUB_ATTACHMENTS_URL

repository_env=$(find_repository_root)/.env
repository_token=$(read_env_value GITHUB_ATTACHMENTS_TOKEN "$repository_env")
[ -z "$repository_token" ] || token=$repository_token

if [ -z "$token" ]; then
  echo "No upload token found in repository .env, GITHUB_ATTACHMENTS_TOKEN, or ~/.config/github-pr-attachments/token" >&2
  exit 1
fi
if [ -z "$service_url" ]; then
  echo "No service URL found in GITHUB_ATTACHMENTS_URL or ~/.config/github-pr-attachments/url" >&2
  exit 1
fi

output=$(mktemp)
trap 'rm -f "$output"' EXIT HUP INT TERM
filename=$(basename "$file")
encoded_filename=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$filename")

set -- \
  --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $token" \
  --header "X-Filename: $encoded_filename" \
  --header "X-Filename-Encoding: percent" \
  --header "Content-Type: $(file --brief --mime-type -- "$file")" \
  --data-binary "@$file" \
  --output "$output"
[ -z "$alt" ] || set -- "$@" --header "X-Alt-Text: $alt"

if ! curl "$@" "${service_url%/}/v1/attachments"; then
  cat "$output" >&2
  exit 1
fi

node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1]));if(typeof x.markdown!=="string")throw Error("invalid response");console.log(x.markdown)' "$output"
