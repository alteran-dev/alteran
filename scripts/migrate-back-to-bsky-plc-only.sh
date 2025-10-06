#!/usr/bin/env bash
set -euo pipefail

# PLC-only migration back to bsky.social
# - Logs into Bluesky (destination) and fetches recommended DID credentials
# - Logs into old PDS, requests PLC email token, signs the op
# - Logs back into Bluesky, submits the op, activates the account, shows status
#
# Env vars (prompts if unset):
#   DID                               # required (did:plc:...)
#   OLD_PDS_HOST, OLD_IDENTIFIER, OLD_PASSWORD, OLD_AUTH_FACTOR
#   BSKY_HOST (default https://bsky.social), BSKY_IDENTIFIER, BSKY_PASSWORD
#   PLC_TOKEN                         # optional; prompt if not set
#   NEW_RECOVERY_DID_KEY              # optional did:key:... to prepend to rotationKeys

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }

default() { local v; v="${!1-}"; if [[ -z "$v" ]]; then printf -- "%s" "$2"; else printf -- "%s" "$v"; fi; }

state_file_path() {
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then echo "${XDG_STATE_HOME}/goat/auth-session.json"; else echo "${HOME}/.local/state/goat/auth-session.json"; fi
}
STATE_FILE="$(state_file_path)"

cache_dir_path() {
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then echo "${XDG_STATE_HOME}/alteran"; else echo "${HOME}/.local/state/alteran"; fi
}

cache_file_path() {
  echo "$(cache_dir_path)/migrate-cache.json"
}

load_cache() {
  local f; f="$(cache_file_path)"
  if [[ -f "$f" ]]; then cat "$f"; else echo '{}'; fi
}

save_cache() {
  local json; json="$1"
  local dir; dir="$(cache_dir_path)"
  mkdir -p "$dir"
  # best-effort restrictive perms
  umask_old=$(umask); umask 077
  printf "%s" "$json" > "$(cache_file_path)"
  umask "$umask_old"
}

merge_json() { # $1 base, $2 patch
  jq -S -c -n --argjson a "$1" --argjson b "$2" '$a * $b'
}

cached() { # $1=key
  load_cache | jq -r --arg k "$1" 'if has($k) then .[$k] else "" end'
}

read_hidden() { local prompt="$1" input; IFS= read -rs -p "$prompt" input; echo >&2; printf -- "%s" "$input"; }
title() { echo; echo "==> $*"; }
info() { echo "[info] $*"; }
warn() { echo "[warn] $*" >&2; }

DID="${DID:-$(cached DID)}"
if [[ -z "${DID}" ]]; then read -r -p "Your PLC DID (did:plc:...): " DID; fi

OLD_PDS_HOST="$(default OLD_PDS_HOST "$(cached OLD_PDS_HOST)")"
if [[ -z "${OLD_PDS_HOST}" ]]; then read -r -p "Old PDS host (e.g. https://pds.example.com): " OLD_PDS_HOST; fi
OLD_IDENTIFIER="$(default OLD_IDENTIFIER "$(cached OLD_IDENTIFIER)")"
if [[ -z "${OLD_IDENTIFIER}" ]]; then read -r -p "Old PDS identifier (handle or DID): " OLD_IDENTIFIER; fi
if [[ -z "${OLD_PASSWORD:-}" ]]; then OLD_PASSWORD="$(cached OLD_PASSWORD)"; fi
if [[ -z "${OLD_PASSWORD}" ]]; then OLD_PASSWORD="$(read_hidden "Old PDS full password for ${OLD_IDENTIFIER}: ")"; fi
OLD_AUTH_FACTOR="${OLD_AUTH_FACTOR:-}"

BSKY_HOST="$(default BSKY_HOST "$(cached BSKY_HOST)")"; if [[ -z "$BSKY_HOST" ]]; then BSKY_HOST="https://bsky.social"; fi
BSKY_IDENTIFIER="$(default BSKY_IDENTIFIER "$(cached BSKY_IDENTIFIER)")"
if [[ -z "${BSKY_IDENTIFIER}" ]]; then read -r -p "Bluesky identifier (handle or DID): " BSKY_IDENTIFIER; fi
if [[ -z "${BSKY_PASSWORD:-}" ]]; then BSKY_PASSWORD="$(cached BSKY_PASSWORD)"; fi
if [[ -z "${BSKY_PASSWORD}" ]]; then BSKY_PASSWORD="$(read_hidden "Bluesky password for ${BSKY_IDENTIFIER}: ")"; fi

TMPDIR_MANUAL=$(mktemp -d 2>/dev/null || mktemp -d -t alteran-plc)
cleanup() { rm -rf "${TMPDIR_MANUAL}" || true; }
trap cleanup EXIT

access_from_refresh() { # $1=host $2=refresh
  curl -fsS -X POST "$1/xrpc/com.atproto.server.refreshSession" \
    -H "Authorization: Bearer $2" -H "Origin: $1" -H "Content-Length: 0" | jq -r .accessJwt
}

# 1) Login to Bluesky and fetch recommended credentials
title "[1/5] Login to Bluesky and fetch recommended DID credentials"
goat account login --username "${BSKY_IDENTIFIER}" --app-password "${BSKY_PASSWORD}" --pds-host "${BSKY_HOST}"
BSKY_REFRESH=$(jq -r .session_token "${STATE_FILE}")
[[ -n "${BSKY_REFRESH}" && "${BSKY_REFRESH}" != null ]] || { echo "Failed to login to Bluesky" >&2; exit 1; }

# Persist cache
save_cache "$(merge_json "$(load_cache)" "$(jq -n --arg DID "$DID" --arg BSKY_HOST "$BSKY_HOST" --arg BSKY_IDENTIFIER "$BSKY_IDENTIFIER" --arg BSKY_PASSWORD "$BSKY_PASSWORD" '{DID:$DID,BSKY_HOST:$BSKY_HOST,BSKY_IDENTIFIER:$BSKY_IDENTIFIER,BSKY_PASSWORD:$BSKY_PASSWORD}')")"

PLC_OP_JSON="${TMPDIR_MANUAL}/plc-op.recommended.json"
goat account plc recommended >"${PLC_OP_JSON}"

if [[ -n "${NEW_RECOVERY_DID_KEY:-}" ]]; then
  if jq -e '.rotationKeys' "${PLC_OP_JSON}" >/dev/null 2>&1; then
    tmp_edit="${PLC_OP_JSON}.edit"
    jq --arg k "${NEW_RECOVERY_DID_KEY}" '
      .rotationKeys as $r |
      ([$k] + ([ $r[] | select(. != $k) ])) as $new |
      .rotationKeys = $new
    ' "${PLC_OP_JSON}" >"${tmp_edit}"
    mv "${tmp_edit}" "${PLC_OP_JSON}"
    info "Inserted NEW_RECOVERY_DID_KEY into rotationKeys"
  else
    warn "recommended credentials missing rotationKeys; leaving as-is"
  fi
fi

# 2) Auto-select signer host (prefer Bluesky if its rotation key is present), request token, sign op
if [[ -z "${SIGN_HOST:-}" ]]; then
  BSKY_ROTATION_DID=$(jq -r '.rotationKeys[0] // empty' "${PLC_OP_JSON}")
  if [[ -n "${BSKY_ROTATION_DID}" ]]; then
    CURRENT_ROTATION_DIDS=$(curl -fsS "https://plc.directory/${DID}/data" | jq -r '.rotationKeys[]?')
    if printf "%s\n" "$CURRENT_ROTATION_DIDS" | grep -Fxq "$BSKY_ROTATION_DID"; then
      SIGN_HOST="$BSKY_HOST"
      SIGN_IDENTIFIER="$BSKY_IDENTIFIER"
      SIGN_PASSWORD="$BSKY_PASSWORD"
      info "Auto-selected signer: Bluesky (${SIGN_HOST})"
    else
      SIGN_HOST="$OLD_PDS_HOST"
      SIGN_IDENTIFIER="$OLD_IDENTIFIER"
      SIGN_PASSWORD="$OLD_PASSWORD"
      info "Auto-selected signer: Old PDS (${SIGN_HOST})"
    fi
  else
    SIGN_HOST="$OLD_PDS_HOST"
    SIGN_IDENTIFIER="$OLD_IDENTIFIER"
    SIGN_PASSWORD="$OLD_PASSWORD"
    info "Auto-selected signer: Old PDS (${SIGN_HOST})"
  fi
else
  SIGN_HOST="$(default SIGN_HOST "$(cached SIGN_HOST)")"
  SIGN_IDENTIFIER="$(default SIGN_IDENTIFIER "$(cached SIGN_IDENTIFIER)")"; if [[ -z "$SIGN_IDENTIFIER" ]]; then SIGN_IDENTIFIER="$OLD_IDENTIFIER"; fi
  if [[ -z "${SIGN_PASSWORD:-}" ]]; then SIGN_PASSWORD="$(cached SIGN_PASSWORD)"; fi
  if [[ -z "${SIGN_PASSWORD}" ]]; then SIGN_PASSWORD="$(read_hidden "Password for signer host ${SIGN_HOST} (${SIGN_IDENTIFIER}): ")"; fi
fi

title "[2/5] Login to signer host and request PLC token"
goat account login --username "${SIGN_IDENTIFIER}" --app-password "${SIGN_PASSWORD}" --pds-host "${SIGN_HOST}"
SIGN_REFRESH=$(jq -r .session_token "${STATE_FILE}")
[[ -n "${SIGN_REFRESH}" && "${SIGN_REFRESH}" != null ]] || { echo "Failed to login to signer host" >&2; exit 1; }

# Persist cache for signer
save_cache "$(merge_json "$(load_cache)" "$(jq -n --arg SIGN_HOST "$SIGN_HOST" --arg SIGN_IDENTIFIER "$SIGN_IDENTIFIER" --arg SIGN_PASSWORD "$SIGN_PASSWORD" '{SIGN_HOST:$SIGN_HOST,SIGN_IDENTIFIER:$SIGN_IDENTIFIER,SIGN_PASSWORD:$SIGN_PASSWORD}')")"

goat account plc request-token || true

PLC_TOKEN_INPUT="${PLC_TOKEN:-}"
if [[ -z "${PLC_TOKEN_INPUT}" ]]; then
  read -r -p "Enter PLC token received by email: " PLC_TOKEN_INPUT
fi

# Persist token last-used (not strictly needed but handy for retries)
save_cache "$(merge_json "$(load_cache)" "$(jq -n --arg PLC_TOKEN "$PLC_TOKEN_INPUT" '{PLC_TOKEN:$PLC_TOKEN}')")"

PLC_OP_SIGNED_JSON="${TMPDIR_MANUAL}/plc-op.signed.json"
set +e
goat account plc sign --token "${PLC_TOKEN_INPUT}" "${PLC_OP_JSON}" >"${PLC_OP_SIGNED_JSON}"
rc=$?
set -e
if [[ ${rc} -ne 0 ]]; then
  warn "goat account plc sign failed; attempting raw XRPC call for diagnostics"
  SIGN_ACCESS=$(access_from_refresh "${SIGN_HOST}" "${SIGN_REFRESH}")
  RAW_BODY=$(jq --arg token "${PLC_TOKEN_INPUT}" '. + {token:$token}' "${PLC_OP_JSON}")
  set +e
  RESP=$(curl -sS -i -X POST "${SIGN_HOST}/xrpc/com.atproto.identity.signPlcOperation" \
    -H "Authorization: Bearer ${SIGN_ACCESS}" \
    -H "Content-Type: application/json" \
    -d "${RAW_BODY}")
  CURL_RC=$?
  set -e
  echo "--- signPlcOperation response (raw) ---"
  echo "${RESP}" | sed 's/.*/  &/'
  echo "---------------------------------------"
  if [[ ${CURL_RC} -ne 0 ]]; then
    echo "curl to signPlcOperation failed" >&2; exit 1
  fi
  # Extract JSON body
  JSON_BODY=$(printf "%s" "${RESP}" | awk 'BEGIN{body=0} /^\r$/{body=1; next} body{print}')
  if echo "${JSON_BODY}" | jq -e '.operation' >/dev/null 2>&1; then
    echo "${JSON_BODY}" | jq '.operation' >"${PLC_OP_SIGNED_JSON}"
    info "Recovered signed op from raw call"
  else
    echo "Could not obtain signed PLC operation (see raw response above)." >&2
    exit 1
  fi
fi

# 3) Login to Bluesky and submit op
title "[3/5] Submit PLC operation via Bluesky"
goat account login --username "${BSKY_IDENTIFIER}" --app-password "${BSKY_PASSWORD}" --pds-host "${BSKY_HOST}"
goat account plc submit "${PLC_OP_SIGNED_JSON}"

# 4) Activate account
title "[4/5] Activate account on Bluesky"
goat account activate

# 5) Show status
title "[5/5] Account status on Bluesky"
BSKY_REFRESH=$(jq -r .session_token "${STATE_FILE}")
BSKY_ACCESS=$(access_from_refresh "${BSKY_HOST}" "${BSKY_REFRESH}")
curl -fsS -H "Authorization: Bearer ${BSKY_ACCESS}" "${BSKY_HOST}/xrpc/com.atproto.server.checkAccountStatus" | jq '.'

echo
echo "Done. If anything looks off, re-run status or resolve DID caches after a few minutes."
