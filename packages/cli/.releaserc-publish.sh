#!/usr/bin/env bash
# Publish mira-cli-ts to npm during semantic-release.
# Uses NPM_TOKEN from the environment (set as a GitHub Actions secret).
# When NPM_TOKEN is unset we skip publishing so a GitHub-only release still works.
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "::warning::NPM_TOKEN is not set — skipping npm publish (GitHub release only)"
  exit 0
fi

# Write an auth .npmrc and pass it via --userconfig (a workspace .npmrc is ignored
# by npm for auth, so --userconfig is required to force-read the token).
NPMRC="$(mktemp)"
trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"

npm publish --access public --userconfig "$NPMRC"
