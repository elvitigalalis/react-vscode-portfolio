#!/usr/bin/env bash
# Sets the two secrets voice capture needs (docs/sheet-voice.md). Run it yourself, in a terminal.
# Neither value is printed or passed on a command line: they go to Supabase through an env file
# readable only by you, deleted on exit, and the capture token goes to the clipboard.
set -euo pipefail

PROJECT_REF=bmbsvvprpfdbvalnkowp

[ -t 0 ] || { echo "Run this in a terminal: it needs to ask for your key." >&2; exit 1; }

read -rsp "Anthropic API key (hidden): " api_key
echo
[ -n "$api_key" ] || { echo "No key given, nothing changed." >&2; exit 1; }

capture_token=$(openssl rand -hex 32)

umask 077
env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT
chmod 600 "$env_file"
printf 'ANTHROPIC_API_KEY=%s\nSHEET_CAPTURE_TOKEN=%s\n' "$api_key" "$capture_token" > "$env_file"

npx -y supabase secrets set --env-file "$env_file" --project-ref "$PROJECT_REF"

printf '%s' "$capture_token" | pbcopy
echo "Secrets set. The capture token is on your clipboard."
echo "Paste it into the Shortcut's Authorization header, after \"Bearer \"."
