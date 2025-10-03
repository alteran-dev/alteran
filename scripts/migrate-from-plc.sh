#!/usr/bin/env bash

set -euo pipefail

# Alteran PLC → Alteran migration helper
# - Creates deactivated account on Alteran
# - Exports CAR from old PDS (Bluesky)
# - Imports CAR into Alteran
# - Loops to sync missing blobs
# - Verifies head/rev and snapshot
#
# Usage: run and follow prompts (recommended).
#
# Optional: pass flags to skip prompts or override defaults:
#   --new <url> --old <url> --did <plc> --handle <handle> --password <USER_PASSWORD>
#   --activate            # call activateAccount at the end (after you flip hosting)
#   --yes                 # skip confirmation prompt for activation
#   --poll-seconds <n>    # max seconds to wait for PLC hosting change (default 300)
#   --no-poll             # skip PLC hosting polling (not recommended)
#
# Notes
# - Requires: curl, jq, awk
# - The script does NOT switch hosting provider for you; do that in Bluesky UI.
# - Activation is left manual (prints the curl to run after you flip hosting).
NEW_DEFAULT="https://rawkode.dev"
OLD_DEFAULT="https://bsky.social"
DID_DEFAULT=""
HANDLE_DEFAULT="rawkode.dev"
PASSWORD_DEFAULT=""
ACTIVATE_DEFAULT="false"
YES_DEFAULT="false"
POLL_SECS_DEFAULT="300"
NO_POLL_DEFAULT="false"

log() { printf "[%s] %s\n" "$(date -Iseconds)" "$*"; }
err() { printf "[ERROR] %s\n" "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 2; }
}

usage() {
  cat <<USAGE
Usage: $0  # prompts for NEW, OLD, DID, HANDLE, PASSWORD
   or: $0 --new <url> --old <url> --did <plc> --handle <handle> [--password <pwd>] [--activate] [--yes]

Defaults when prompted:
  NEW     [${NEW_DEFAULT}]
  OLD     [${OLD_DEFAULT}]
  DID     (required, e.g. did:plc:35bdlgus7hihmup66o265nuy)
  HANDLE  [${HANDLE_DEFAULT}]
  PASSWORD (USER_PASSWORD on Alteran; hidden input)
  ACTIVATE (${ACTIVATE_DEFAULT}) via --activate
  YES (${YES_DEFAULT}) via --yes
  POLL-SECONDS (${POLL_SECS_DEFAULT}) via --poll-seconds
  NO-POLL (${NO_POLL_DEFAULT}) via --no-poll
USAGE
}

NEW="${NEW:-$NEW_DEFAULT}"
OLD="${OLD:-$OLD_DEFAULT}"
DID="${DID:-$DID_DEFAULT}"
HANDLE="${HANDLE:-$HANDLE_DEFAULT}"
PASSWORD="${PASSWORD:-$PASSWORD_DEFAULT}"
ACTIVATE="${ACTIVATE:-$ACTIVATE_DEFAULT}"
YES="${YES:-$YES_DEFAULT}"
POLL_SECS="${POLL_SECS:-$POLL_SECS_DEFAULT}"
NO_POLL="${NO_POLL:-$NO_POLL_DEFAULT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW="$2"; shift 2 ;;
    --old) OLD="$2"; shift 2 ;;
    --did) DID="$2"; shift 2 ;;
    --handle) HANDLE="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --activate) ACTIVATE="true"; shift 1 ;;
    --yes) YES="true"; shift 1 ;;
    --poll-seconds) POLL_SECS="$2"; shift 2 ;;
    --no-poll) NO_POLL="true"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

require_cmd curl
require_cmd jq
require_cmd awk

prompt_value() {
  # $1 var name, $2 prompt label, $3 default (optional)
  local __name="$1"; shift
  local __label="$1"; shift
  local __default="${1-}"
  local __input
  if [[ -n "$__default" ]]; then
    read -r -p "$__label [$__default]: " __input || true
  else
    read -r -p "$__label: " __input || true
  fi
  if [[ -z "$__input" && -n "$__default" ]]; then __input="$__default"; fi
  printf -v "$__name" '%s' "$__input"
}

prompt_secret() {
  # $1 var name, $2 prompt label
  local __name="$1"; shift
  local __label="$1"; shift
  local __input
  read -r -s -p "$__label: " __input || true
  echo
  printf -v "$__name" '%s' "$__input"
}

# Interactive prompts when values are missing
if [[ -z "$NEW" ]]; then prompt_value NEW "New PDS URL" "$NEW_DEFAULT"; fi
if [[ -z "$OLD" ]]; then prompt_value OLD "Old PDS URL" "$OLD_DEFAULT"; fi
if [[ -z "$HANDLE" ]]; then prompt_value HANDLE "Handle" "$HANDLE_DEFAULT"; fi
if [[ -z "$DID" ]]; then
  while :; do
    prompt_value DID "Your DID (did:plc:...)"
    [[ -n "$DID" ]] && [[ "$DID" =~ ^did:plc: ]] && break
    err "Please enter a valid did:plc:... value."
  done
fi
if [[ -z "$PASSWORD" ]]; then
  prompt_secret PASSWORD "Enter USER_PASSWORD for $NEW"
fi

WORKDIR="migration-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORKDIR"

http_json() {
  # $1: method, $2: url, remaining: curl args
  local method="$1"; shift
  local url="$1"; shift
  local out_json="$WORKDIR/curl.$(date +%s%3N).json"
  local out_code
  out_code=$(curl -sS -X "$method" "$url" -o "$out_json" -w '%{http_code}' "$@" || true)
  echo "$out_code" "$out_json"
}

preflight() {
  log "Preflight checks against $NEW"
  local did_wk
  did_wk=$(curl -fsS "$NEW/.well-known/atproto-did" || true)
  if [[ -z "$did_wk" ]]; then
    err "New PDS did not return /.well-known/atproto-did"
    exit 1
  fi
  if [[ "$did_wk" != "$DID" ]]; then
    err "PDS_DID mismatch: expected $DID, got $did_wk. Reconfigure Alteran and redeploy."
    exit 1
  fi
  # Optional: handle resolution (warn only)
  local rh_code rh_body
  read -r rh_code rh_body < <(http_json GET "$NEW/xrpc/com.atproto.identity.resolveHandle?handle=$HANDLE")
  if [[ "$rh_code" != "200" ]]; then
    log "WARN: resolveHandle did not return 200 (code=$rh_code). Ensure _atproto TXT exists for $HANDLE -> $DID."
  else
    local resolved_did
    resolved_did=$(jq -r '.did // empty' "$rh_body")
    if [[ "$resolved_did" != "$DID" ]]; then
      log "WARN: handle $HANDLE resolves to $resolved_did (expected $DID) — DNS may still be propagating."
    fi
  fi
}

get_access_token() {
  log "Creating admin session on Alteran"
  local code body
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.server.createSession" \
    -H 'content-type: application/json' \
    --data-binary "{\"identifier\":\"admin\",\"password\":\"$PASSWORD\"}")
  if [[ "$code" != "200" ]]; then
    err "createSession failed (HTTP $code): $(cat "$body")"
    exit 1
  fi
  ACCESS=$(jq -r '.accessJwt // empty' "$body")
  if [[ -z "$ACCESS" ]]; then
    err "No accessJwt in response"
    exit 1
  fi
}

create_account_deactivated() {
  log "Creating deactivated account on Alteran"
  local code body
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.server.createAccount" \
    -H "authorization: Bearer $ACCESS" \
    -H 'content-type: application/json' \
    --data-binary "{\"did\":\"$DID\",\"handle\":\"$HANDLE\",\"deactivated\":true}")
  if [[ "$code" == "200" ]]; then
    log "Account created in deactivated state."
  else
    # Tolerate already exists
    if jq -e '(.error? // "") == "AccountAlreadyExists"' "$body" >/dev/null 2>&1; then
      log "Account already exists — continuing."
    else
      err "createAccount failed (HTTP $code): $(cat "$body")"
      exit 1
    fi
  fi
}

export_repo() {
  log "Exporting CAR from old PDS ($OLD)"
  curl -fsS -H 'accept: application/vnd.ipld.car' \
    "$OLD/xrpc/com.atproto.sync.getRepo?did=$DID" \
    -o "$WORKDIR/repo.car"
  if [[ ! -s "$WORKDIR/repo.car" ]]; then
    err "Repo export failed or empty."
    exit 1
  fi
  log "Exported $(du -h "$WORKDIR/repo.car" | awk '{print $1}')"
}

import_repo() {
  log "Importing CAR into Alteran ($NEW)"
  local code body
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.repo.importRepo" \
    -H "authorization: Bearer $ACCESS" \
    -H 'content-type: application/vnd.ipld.car' \
    --data-binary @"$WORKDIR/repo.car")
  if [[ "$code" != "200" ]]; then
    err "importRepo failed (HTTP $code): $(cat "$body")"
    exit 1
  fi
  log "Import response: $(jq -c '.' "$body")"
}

list_missing() {
  curl -s "$NEW/xrpc/com.atproto.repo.listMissingBlobs?limit=500" -H "authorization: Bearer $ACCESS" | jq -r '.blobs[].cid'
}

sync_blobs_loop() {
  log "Syncing blobs from old → new (may repeat in pages)"
  local iter=0
  while :; do
    iter=$((iter+1))
    local cids
    cids=$(list_missing)
    if [[ -z "$cids" ]]; then
      log "No missing blobs."
      break
    fi
    local count=0
    while read -r cid; do
      [[ -z "$cid" ]] && continue
      count=$((count+1))
      curl -s -D "$WORKDIR/headers.txt" -o "$WORKDIR/blob.bin" \
        "$OLD/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$cid"
      local mime
      mime=$(awk -F': ' 'tolower($1) == "content-type" {print $2}' "$WORKDIR/headers.txt" | tr -d '\r')
      mime=${mime:-application/octet-stream}
      curl -sS -X POST "$NEW/xrpc/com.atproto.repo.uploadBlob" \
        -H "authorization: Bearer $ACCESS" \
        -H "content-type: $mime" \
        --data-binary @"$WORKDIR/blob.bin" >/dev/null
    done <<< "$cids"
    log "Page $iter uploaded $count blobs; checking again..."
  done
}

status() {
  log "Checking account status"
  curl -s "$NEW/xrpc/com.atproto.server.checkAccountStatus" -H "authorization: Bearer $ACCESS" | jq
}

verify_snapshot() {
  log "Fetching verification snapshot from Alteran"
  curl -s "$NEW/xrpc/com.atproto.sync.getRepo?did=$DID" -o "$WORKDIR/verify.car"
  if [[ ! -s "$WORKDIR/verify.car" ]]; then
    err "Verify snapshot is empty."
    exit 1
  fi
  log "verify.car size: $(du -h "$WORKDIR/verify.car" | awk '{print $1}')"
}

activate_account() {
  if [[ "$ACTIVATE" != "true" ]]; then
    return 0
  fi
  log "Activation requested (--activate)."
  if [[ "$YES" != "true" ]]; then
    echo "Have you switched hosting provider in Bluesky to $NEW?"
    read -r -p "Type 'activate' to proceed, or anything else to abort: " CONFIRM
    if [[ "$CONFIRM" != "activate" ]]; then
      err "Activation aborted by user."
      return 1
    fi
  fi
  log "Calling com.atproto.server.activateAccount on $NEW"
  local code body
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.server.activateAccount" \
    -H "authorization: Bearer $ACCESS")
  if [[ "$code" != "200" ]]; then
    err "activateAccount failed (HTTP $code): $(cat "$body")"
    return 1
  fi
  log "Activated: $(jq -c '.' "$body")"
  status
}

normalize_url() {
  local u="$1"
  # remove trailing slashes
  u="${u%%/}"
  echo "$u"
}

wait_for_plc_hosting() {
  if [[ "$NO_POLL" == "true" ]]; then
    log "Skipping PLC hosting polling (--no-poll)."
    return 0
  fi

  local want
  want=$(normalize_url "$NEW")
  log "Waiting for PLC to point $DID to $want (timeout ${POLL_SECS}s)"

  local deadline
  deadline=$(( $(date +%s) + POLL_SECS ))
  local interval=10

  while (( $(date +%s) < deadline )); do
    local got
    got=$(curl -fsS "https://plc.directory/$DID" | \
      jq -r '((.service // []) | map(select(.type=="AtprotoPersonalDataServer")) | .[0].serviceEndpoint) // (.services.atproto_pds.endpoint // empty) // empty' 2>/dev/null || true)
    got=$(normalize_url "$got")

    if [[ -n "$got" && "$got" == "$want" ]]; then
      log "PLC now lists PDS endpoint: $got"
      return 0
    fi

    log "PLC not updated yet (saw: ${got:-none}); sleeping ${interval}s..."
    sleep "$interval"
  done

  err "Timed out waiting for PLC hosting change after ${POLL_SECS}s."
  return 1
}

main() {
  log "Starting migration: DID=$DID NEW=$NEW OLD=$OLD HANDLE=$HANDLE"
  preflight
  get_access_token
  create_account_deactivated
  export_repo
  import_repo
  sync_blobs_loop
  status
  verify_snapshot
  if [[ "$ACTIVATE" == "true" ]]; then
    if wait_for_plc_hosting; then
      activate_account || true
    else
      log "Skipping activation because PLC did not update in time."
    fi
  fi
  cat <<NEXT

Next steps:
1) In Bluesky: Settings → Advanced → Change hosting provider → enter $NEW
2) If you did not pass --activate (or you aborted), then activate on Alteran:
   curl -sX POST "$NEW/xrpc/com.atproto.server.activateAccount" -H "authorization: Bearer $ACCESS" | jq
3) Re-run status after activation in any case:
   curl -s "$NEW/xrpc/com.atproto.server.checkAccountStatus" -H "authorization: Bearer $ACCESS" | jq

Workdir: $WORKDIR
NEXT
}

main "$@"
