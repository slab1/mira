#!/usr/bin/env bash
set -euo pipefail

OWNER=""
APPEND_FILE=""
ROTATE=0

usage() {
  cat <<'USAGE'
Usage: gen-mira-token.sh [OPTIONS]

Generate strong MIRA_TOKEN or MIRA_API_KEYS entries.

Options:
  --owner <name>     Generate a single MIRA_API_KEYS entry as <key>:<owner>
                     Key is 48 bytes hex (96 hex chars). If omitted, generates
                     MIRA_TOKEN (32 bytes hex = 64 hex chars).
  --append <file>    Append the generated line to <file> (creates parent dir,
                     chmod 600). Adds a comment with timestamp. If not given,
                     prints to stdout only.
  --rotate           Print rotation instructions after generation.
  -h, --help         Show this help and exit.

Examples:
  ./scripts/gen-mira-token.sh
  ./scripts/gen-mira-token.sh --owner alice
  ./scripts/gen-mira-token.sh --append ~/.mira/mira.env
  ./scripts/gen-mira-token.sh --owner alice --append ~/.mira/mira.env
  ./scripts/gen-mira-token.sh --owner alice --append ~/.mira/mira.env --rotate

Entropy sources (in order): openssl rand -hex, node crypto.randomBytes, /dev/urandom
USAGE
}

gen_hex() {
  local nbytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$nbytes"
  elif command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes(${nbytes}).toString('hex'))"
  elif [ -r /dev/urandom ]; then
    if command -v od >/dev/null 2>&1; then
      od -An -v -tx1 /dev/urandom | tr -d ' \n' | head -c $((nbytes * 2))
    elif command -v hexdump >/dev/null 2>&1; then
      hexdump -v -e '/1 "%02x"' /dev/urandom | head -c $((nbytes * 2))
    elif command -v xxd >/dev/null 2>&1; then
      head -c "$nbytes" /dev/urandom | xxd -p -c 256 | tr -d '\n'
    else
      echo "error: no hex encoder found (need od, hexdump, or xxd)" >&2
      exit 1
    fi
  else
    echo "error: no entropy source found (install openssl or nodejs)" >&2
    exit 1
  fi
}

# --- parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "error: --owner requires an argument" >&2
        usage >&2
        exit 1
      fi
      OWNER="$2"
      shift 2
      ;;
    --owner=*)
      OWNER="${1#*=}"
      shift
      ;;
    --append)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "error: --append requires a file path" >&2
        usage >&2
        exit 1
      fi
      APPEND_FILE="$2"
      shift 2
      ;;
    --append=*)
      APPEND_FILE="${1#*=}"
      shift
      ;;
    --rotate)
      ROTATE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# validate owner if given
if [[ -n "$OWNER" ]]; then
  if ! [[ "$OWNER" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "error: --owner must match ^[a-zA-Z0-9._-]+\$ (got: $OWNER)" >&2
    exit 1
  fi
fi

# --- generate ---
LINE=""
if [[ -n "$OWNER" ]]; then
  KEY="$(gen_hex 48)"
  # 48 bytes = 96 hex chars
  ENTRY="${KEY}:${OWNER}"
  LINE="MIRA_API_KEYS=${ENTRY}"
else
  TOKEN="$(gen_hex 32)"
  # 32 bytes = 64 hex chars
  LINE="MIRA_TOKEN=${TOKEN}"
fi

# ensure non-empty and correct length
if [[ -z "$LINE" ]]; then
  echo "error: failed to generate token" >&2
  exit 1
fi

# print to stdout always
echo "$LINE"

# --- append to file if requested ---
if [[ -n "$APPEND_FILE" ]]; then
  # expand leading ~ to $HOME (bash does not expand ~ in variables)
  EXPANDED="$APPEND_FILE"
  if [[ "$EXPANDED" == "~/"* ]]; then
    EXPANDED="${HOME}${EXPANDED:1}"
  elif [[ "$EXPANDED" == "~" ]]; then
    EXPANDED="$HOME"
  fi

  DIR="$(dirname "$EXPANDED")"
  mkdir -p "$DIR"
  # create file if missing
  touch "$EXPANDED"
  chmod 600 "$EXPANDED"

  # idempotent: skip if exact line already present
  if grep -Fxq -- "$LINE" "$EXPANDED" 2>/dev/null; then
    echo "[gen-mira-token] already present in $APPEND_FILE — skipping append" >&2
  else
    TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"
    {
      # add leading newline if file is non-empty and doesn't end with newline
      if [[ -s "$EXPANDED" ]] && [[ -n "$(tail -c1 "$EXPANDED" 2>/dev/null)" ]]; then
        echo ""
      fi
      echo "# gen-mira-token.sh ${OWNER:+--owner $OWNER }on $TIMESTAMP"
      echo "$LINE"
    } >> "$EXPANDED"
    # ensure permissions after append
    chmod 600 "$EXPANDED"
    echo "[gen-mira-token] appended to $APPEND_FILE (chmod 600)" >&2
    if [[ -n "$OWNER" ]]; then
      # hint about merging multiple keys
      if grep -q "^MIRA_API_KEYS=" "$EXPANDED" 2>/dev/null; then
        COUNT="$(grep -c "^MIRA_API_KEYS=" "$EXPANDED" || true)"
        if [[ "$COUNT" -gt 1 ]]; then
          echo "[gen-mira-token] note: $COUNT MIRA_API_KEYS lines in $APPEND_FILE — merge them as comma-separated: MIRA_API_KEYS=key1:owner1,key2:owner2" >&2
        fi
      fi
    fi
  fi
fi

# --- rotation instructions ---
if [[ "$ROTATE" -eq 1 ]]; then
  cat >&2 <<'ROTATE'

--rotate: rotation instructions
  1. Generate a new value (you just did).
  2. If using --append, the new value is already in your env file.
     Otherwise, manually update ~/.mira/mira.env or your deployment secrets:
       MIRA_TOKEN=<new>  or  MIRA_API_KEYS=<new>:<owner>[,...]
     For multiple owners, comma-join pairs: MIRA_API_KEYS=key1:alice,key2:bob
  3. Restart the server so the new value takes effect:
       scripts/serve-local.sh stop; scripts/serve-local.sh start
     Or if running via systemd/docker, restart that unit/container.
  4. Verify: curl -H "Authorization: Bearer <new>" http://127.0.0.1:4096/health
  5. Revoke the old token/key — remove it from the env file and any
     client configs (packages/slack .env, CI secrets, etc.).
  6. Keep file permissions 600: chmod 600 ~/.mira/mira.env
ROTATE
fi
