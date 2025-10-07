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
DID_DEFAULT="did:plc:35bdlgus7hihmup66o265nuy"
HANDLE_DEFAULT="rawkode.dev"
PASSWORD_DEFAULT=""
ACTIVATE_DEFAULT="false"
YES_DEFAULT="false"
POLL_SECS_DEFAULT="300"
NO_POLL_DEFAULT="false"
SKIP_BLOBS_DEFAULT="false"

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
  SKIP-BLOBS (${SKIP_BLOBS_DEFAULT}) via --skip-blobs
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
SKIP_BLOBS="${SKIP_BLOBS:-$SKIP_BLOBS_DEFAULT}"

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
    --skip-blobs) SKIP_BLOBS="true"; shift 1 ;;
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
  prompt_value DID "Your DID (did:plc:...)" "$DID_DEFAULT"
  if [[ -z "$DID" ]] || ! [[ "$DID" =~ ^did:plc: ]]; then
    err "Please provide a valid did:plc:... value."
    exit 1
  fi
fi

WORKDIR="migration-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORKDIR"

# Copy cached tokens from most recent migration directory if they exist
LATEST_MIGRATION=$(ls -dt migration-* 2>/dev/null | head -1)
if [[ -n "$LATEST_MIGRATION" && "$LATEST_MIGRATION" != "$WORKDIR" ]]; then
  if [[ -f "$LATEST_MIGRATION/.new_access_token" ]]; then
    cp "$LATEST_MIGRATION/.new_access_token" "$WORKDIR/.new_access_token"
    log "Copied cached Alteran token from $LATEST_MIGRATION"
  fi
  if [[ -f "$LATEST_MIGRATION/.old_access_token" ]]; then
    cp "$LATEST_MIGRATION/.old_access_token" "$WORKDIR/.old_access_token"
    log "Copied cached old PDS token from $LATEST_MIGRATION"
  fi
fi

# Only prompt for password if we don't have a cached token
if [[ -z "$PASSWORD" ]] && [[ ! -f "$WORKDIR/.new_access_token" ]]; then
  prompt_secret PASSWORD "Enter USER_PASSWORD for $NEW"
fi

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
  # Check for cached token first
  if [[ -f "$WORKDIR/.new_access_token" ]]; then
    ACCESS=$(cat "$WORKDIR/.new_access_token")
    log "Using cached Alteran access token"
    # Verify token is still valid
    local test_code
    test_code=$(curl -sS -o /dev/null -w '%{http_code}' "$NEW/xrpc/com.atproto.server.getSession" \
      -H "authorization: Bearer $ACCESS" || true)
    if [[ "$test_code" == "200" ]]; then
      log "Cached token is valid"
      return 0
    else
      log "Cached token expired, creating new session"
    fi
  fi

  log "Creating session on Alteran as $HANDLE"
  local code body
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.server.createSession" \
    -H 'content-type: application/json' \
    --data-binary "{\"identifier\":\"$HANDLE\",\"password\":\"$PASSWORD\"}")
  if [[ "$code" != "200" ]]; then
    err "createSession failed (HTTP $code): $(cat "$body")"
    exit 1
  fi
  ACCESS=$(jq -r '.accessJwt // empty' "$body")
  if [[ -z "$ACCESS" ]]; then
    err "No accessJwt in response"
    exit 1
  fi
  # Cache the token
  echo "$ACCESS" > "$WORKDIR/.new_access_token"
  chmod 600 "$WORKDIR/.new_access_token"
}

get_old_access_token() {
  # Check for cached token first
  if [[ -f "$WORKDIR/.old_access_token" ]]; then
    OLD_ACCESS=$(cat "$WORKDIR/.old_access_token")
    log "Using cached old PDS access token"
    # Verify token is still valid
    local test_code
    test_code=$(curl -sS -o /dev/null -w '%{http_code}' "$OLD/xrpc/com.atproto.server.getSession" \
      -H "authorization: Bearer $OLD_ACCESS" || true)
    if [[ "$test_code" == "200" ]]; then
      log "Cached token is valid"
      return 0
    else
      log "Cached token expired, creating new session"
    fi
  fi

  log "Creating session on old PDS ($OLD)"
  local old_password
  prompt_secret old_password "Enter password for $HANDLE on $OLD"

  local code body
  read -r code body < <(http_json POST "$OLD/xrpc/com.atproto.server.createSession" \
    -H 'content-type: application/json' \
    --data-binary "{\"identifier\":\"$HANDLE\",\"password\":\"$old_password\"}")
  if [[ "$code" != "200" ]]; then
    err "createSession on old PDS failed (HTTP $code): $(cat "$body")"
    exit 1
  fi
  OLD_ACCESS=$(jq -r '.accessJwt // empty' "$body")
  if [[ -z "$OLD_ACCESS" ]]; then
    err "No accessJwt in response from old PDS"
    exit 1
  fi
  # Cache the token
  echo "$OLD_ACCESS" > "$WORKDIR/.old_access_token"
  chmod 600 "$WORKDIR/.old_access_token"
}

export_repo() {
  log "Exporting CAR from old PDS ($OLD)"
  curl -fsS -H 'accept: application/vnd.ipld.car' \
    -H "authorization: Bearer $OLD_ACCESS" \
    "$OLD/xrpc/com.atproto.sync.getRepo?did=$DID" \
    -o "$WORKDIR/repo.car"
  if [[ ! -s "$WORKDIR/repo.car" ]]; then
    err "Repo export failed or empty."
    exit 1
  fi
  log "Exported $(du -h "$WORKDIR/repo.car" | awk '{print $1}')"
}

import_repo() {
  log "Importing CAR into Alteran using local D1 import (bypasses Worker limits)"

  # Get the directory where this script is located
  local SCRIPT_DIR
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # Use local script to import directly to D1
  if ! bun "$SCRIPT_DIR/import-car-to-d1.ts" "$WORKDIR/repo.car" "$DID"; then
    err "Local D1 import failed"
    exit 1
  fi

  log "Import completed successfully"
}

list_blobs_from_old() {
  # Get the authoritative list of blobs from the old PDS
  local cursor=""
  local all_cids=""

  while :; do
    local url="$OLD/xrpc/com.atproto.sync.listBlobs?did=$DID&limit=500"
    if [[ -n "$cursor" ]]; then
      url="$url&cursor=$cursor"
    fi

    local response
    response=$(curl -s "$url" -H "authorization: Bearer $OLD_ACCESS")

    local cids
    cids=$(echo "$response" | jq -r '.cids[]? // empty')

    if [[ -z "$cids" ]]; then
      break
    fi

    all_cids="$all_cids$cids"$'\n'

    cursor=$(echo "$response" | jq -r '.cursor // empty')
    if [[ -z "$cursor" ]]; then
      break
    fi
  done

  echo "$all_cids" | grep -v '^$'
}

list_missing_blobs_from_new() {
  # Page through com.atproto.repo.listMissingBlobs on the NEW PDS
  local cursor=""
  local all_missing=""
  while :; do
    local url="$NEW/xrpc/com.atproto.repo.listMissingBlobs?limit=500"
    if [[ -n "$cursor" ]]; then url="$url&cursor=$cursor"; fi
    local res
    res=$(curl -s "$url" -H "authorization: Bearer $ACCESS")
    # Our implementation returns { blobs: [{cid}], cursor }
    local cids
    cids=$(echo "$res" | jq -r '.blobs[]?.cid // empty')
    if [[ -z "$cids" ]]; then
      break
    fi
    all_missing+="$cids"$'\n'
    cursor=$(echo "$res" | jq -r '.cursor // empty')
    if [[ -z "$cursor" ]]; then
      break
    fi
  done
  echo "$all_missing" | grep -v '^$'
}

sync_blobs_loop() {
  if [[ "$SKIP_BLOBS" == "true" ]]; then
    log "Skipping blob sync (--skip-blobs)"
    return 0
  fi

  log "Discovering missing blobs on NEW (com.atproto.repo.listMissingBlobs)"
  local missing
  missing=$(list_missing_blobs_from_new)
  if [[ -z "$missing" ]]; then
    log "No missing blobs to upload."
    return 0
  fi

  local total_count
  total_count=$(echo "$missing" | wc -l)
  log "Missing $total_count blobs; fetching from OLD and uploading to NEW"

  local uploaded=0
  local failed=0
  local processed=0
  while read -r cid; do
    [[ -z "$cid" ]] && continue
    processed=$((processed+1))

    # Fetch from OLD (follow redirects)
    curl -sL -D "$WORKDIR/headers.txt" -o "$WORKDIR/blob.bin" \
      -H "authorization: Bearer $OLD_ACCESS" \
      -H "accept: */*" \
      "$OLD/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$cid"

    # If JSON error, skip (blob may have expired/deleted upstream)
    if head -c 100 "$WORKDIR/blob.bin" | grep -q '{"error"'; then
      continue
    fi

    local mime
    mime=$(awk -F': ' 'tolower($1) == "content-type" {ct=$2} END {print ct}' "$WORKDIR/headers.txt" | tr -d '\r')
    mime=${mime:-application/octet-stream}

    local upload_result
    upload_result=$(curl -sS -X POST "$NEW/xrpc/com.atproto.repo.uploadBlob" \
      -H "authorization: Bearer $ACCESS" \
      -H "content-type: $mime" \
      --data-binary @"$WORKDIR/blob.bin" 2>&1)
    if [[ $? -ne 0 ]] || echo "$upload_result" | jq -e '.error' >/dev/null 2>&1; then
      failed=$((failed+1))
      log "WARN: Failed to upload blob $cid: $upload_result"
    else
      uploaded=$((uploaded+1))
    fi

    if (( processed % 100 == 0 )); then
      log "Progress: $uploaded uploaded, $failed failed, $processed/$total_count processed"
    fi
  done <<< "$missing"

  log "Blob sync complete: $uploaded uploaded, $failed failed, $total_count total missing"
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

request_and_submit_plc_operation() {
  log "Step 1: Requesting 2FA token from old PDS"
  local code body
  read -r code body < <(http_json POST "$OLD/xrpc/com.atproto.identity.requestPlcOperationSignature" \
    -H "authorization: Bearer $OLD_ACCESS")

  if [[ "$code" != "200" ]]; then
    err "requestPlcOperationSignature failed (HTTP $code): $(cat "$body")"
    log "Check your email for the 2FA token, or use Bluesky app to change hosting provider."
    return 1
  fi

  log "Check your email for the PLC operation token"
  local plc_token
  read -r -p "Enter PLC token from email: " plc_token
  if [[ -z "$plc_token" ]]; then
    err "PLC token is required"
    return 1
  fi

  log "Step 2: Getting recommended credentials from new PDS"
  read -r code body < <(http_json GET "$NEW/xrpc/com.atproto.identity.getRecommendedDidCredentials" \
    -H "authorization: Bearer $ACCESS")

  if [[ "$code" != "200" ]]; then
    msg=$(cat "$body")
    err "getRecommendedDidCredentials failed (HTTP $code): $msg"
    if echo "$msg" | grep -qi 'Signing key not configured'; then
      log "HINT: Set REPO_SIGNING_KEY in your Worker secrets (secp256k1 private key in hex or base64)."
      log "      Then: wrangler secret put REPO_SIGNING_KEY --env production"
    fi
    return 1
  fi

  # Save the recommended credentials
  local recommended
  recommended=$(cat "$body")

  # Sanity: ensure recommended atproto key comes from our REPO_SIGNING_KEY (secp256k1 did:key)
  local rec_atproto
  rec_atproto=$(echo "$recommended" | jq -r '.verificationMethods.atproto // empty')
  if [[ -z "$rec_atproto" ]]; then
    err "Recommended credentials missing verificationMethods.atproto."
    err "Ensure REPO_SIGNING_KEY is configured on $NEW."
    return 1
  fi
  log "Using atproto verification method from NEW (derived from REPO_SIGNING_KEY): $rec_atproto"
  # Optional: basic format check for did:key
  if ! echo "$rec_atproto" | grep -q '^did:key:'; then
    log "WARN: atproto did:key does not look like a did:key URI: $rec_atproto"
  fi

  log "Step 3: Having old PDS sign the operation with token"
  read -r code body < <(http_json POST "$OLD/xrpc/com.atproto.identity.signPlcOperation" \
    -H "authorization: Bearer $OLD_ACCESS" \
    -H "content-type: application/json" \
    --data-binary "{\"token\":\"$plc_token\",\"rotationKeys\":$(echo "$recommended" | jq -c '.rotationKeys'),\"alsoKnownAs\":$(echo "$recommended" | jq -c '.alsoKnownAs'),\"verificationMethods\":$(echo "$recommended" | jq -c '.verificationMethods'),\"services\":$(echo "$recommended" | jq -c '.services')}")

  if [[ "$code" != "200" ]]; then
    err "signPlcOperation failed (HTTP $code): $(cat "$body")"
    return 1
  fi

  local operation
  operation=$(jq -c '.operation // empty' "$body")
  if [[ -z "$operation" ]]; then
    err "No operation in response"
    return 1
  fi

  log "Step 4: Submitting signed operation via new PDS"
  read -r code body < <(http_json POST "$NEW/xrpc/com.atproto.identity.submitPlcOperation" \
    -H "authorization: Bearer $ACCESS" \
    -H "content-type: application/json" \
    --data-binary "{\"operation\":$operation}")

  if [[ "$code" != "200" ]]; then
    err "submitPlcOperation failed (HTTP $code): $(cat "$body")"
    return 1
  fi

  log "PLC operation submitted successfully"
  return 0
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
  log "Waiting for PLC to propagate hosting change to $want (timeout ${POLL_SECS}s)"
  log "This usually takes 10-30 seconds..."

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
  get_old_access_token
  export_repo
  import_repo
  sync_blobs_loop
  status
  verify_snapshot

  # Request and submit PLC operation to change hosting
  if request_and_submit_plc_operation; then
    log "PLC operation submitted. Waiting for propagation..."

    if [[ "$ACTIVATE" == "true" ]]; then
      if wait_for_plc_hosting; then
        activate_account || true
      else
        log "Skipping activation because PLC did not update in time."
        log "You can activate manually after PLC propagates."
      fi
    fi
  else
    log "PLC operation failed. You may need to change hosting manually."
  fi

  cat <<NEXT

=============================================================================
MIGRATION COMPLETE
=============================================================================

Data transfer: ✓ Complete
PLC operation: $(if [[ -f "$WORKDIR/plc-response.json" ]]; then echo "✓ Submitted"; else echo "⚠ Manual action required"; fi)

NEXT STEPS:

$(if [[ "$ACTIVATE" != "true" ]]; then
  cat <<ACTIVATE
1) Wait for PLC to propagate (10-30 seconds), then activate your account:
   curl -sX POST "$NEW/xrpc/com.atproto.server.activateAccount" \\
     -H "authorization: Bearer $ACCESS" | jq

2) Verify your account status:
   curl -s "$NEW/xrpc/com.atproto.server.checkAccountStatus" \\
     -H "authorization: Bearer $ACCESS" | jq
ACTIVATE
else
  echo "Account activation: $(if grep -q "activated" "$WORKDIR"/*.json 2>/dev/null; then echo "✓ Complete"; else echo "Check status above"; fi)"
fi)

Migration workspace: $WORKDIR
Access token: $WORKDIR/.new_access_token

=============================================================================
NEXT
}

main "$@"
