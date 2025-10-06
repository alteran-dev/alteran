#!/usr/bin/env bash
set -euo pipefail

# Manual migration to bsky.social using service-auth for createAccount,
# followed by repo import, blob transfer, preferences (best-effort),
# PLC rotation, activation, and old PDS deactivation.
#
# Requirements:
# - goat (this repo's CLI) on PATH
# - curl, jq
#
# You can preseed values via env vars to avoid prompts:
#   OLD_PDS_HOST, OLD_IDENTIFIER, OLD_PASSWORD, OLD_AUTH_FACTOR
#   DID, NEW_PDS_HOST, NEW_HANDLE, NEW_PASSWORD, NEW_EMAIL, INVITE_CODE, PLC_TOKEN
#   NEW_RECOVERY_DID_KEY  # optional: did:key:z... to prepend to rotationKeys
#
# Note: This script will switch your goat session between old and new PDS.

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need_cmd goat
need_cmd curl
need_cmd jq

default() { # $1=name, $2=default
  local v
  v="${!1-}"
  if [[ -z "${v}" ]]; then printf -- "%s" "$2"; else printf -- "%s" "$v"; fi
}

state_file_path() {
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then
    echo "${XDG_STATE_HOME}/goat/auth-session.json"
  else
    echo "${HOME}/.local/state/goat/auth-session.json"
  fi
}

read_hidden() { # $1=prompt -> echoes var
  local prompt="$1" input
  IFS= read -rs -p "$prompt" input; echo >&2; printf -- "%s" "$input"
}

title() { echo; echo "==> $*"; }
info() { echo "[info] $*"; }
warn() { echo "[warn] $*" >&2; }

# --- Collect inputs (with sensible defaults for your case) ---
OLD_PDS_HOST="$(default OLD_PDS_HOST "https://rawkode.dev")"
OLD_IDENTIFIER="$(default OLD_IDENTIFIER "rawkode.dev")"
DID="$(default DID "did:plc:35bdlgus7hihmup66o265nuy")"
NEW_PDS_HOST="$(default NEW_PDS_HOST "https://bsky.social")"

echo "Manual Bluesky Migration"
echo "-------------------------"
echo "Old PDS host         : ${OLD_PDS_HOST}"
echo "Old identifier       : ${OLD_IDENTIFIER}"
echo "Existing DID         : ${DID}"
echo "Destination PDS host : ${NEW_PDS_HOST}"

if [[ -z "${OLD_PASSWORD:-}" ]]; then
  OLD_PASSWORD="$(read_hidden "Old PDS full password for ${OLD_IDENTIFIER}: ")"
fi

if [[ -z "${NEW_HANDLE:-}" ]]; then
  read -r -p "Desired handle on ${NEW_PDS_HOST} (e.g., rawkode-new.bsky.social): " NEW_HANDLE
fi
if [[ -z "${NEW_EMAIL:-}" ]]; then
  read -r -p "Email address for the new account: " NEW_EMAIL
fi
if [[ -z "${NEW_PASSWORD:-}" ]]; then
  NEW_PASSWORD="$(read_hidden "Password to use on ${NEW_PDS_HOST} (leave empty to reuse old): ")"
  if [[ -z "${NEW_PASSWORD}" ]]; then NEW_PASSWORD="${OLD_PASSWORD}"; fi
fi
if [[ -z "${INVITE_CODE:-}" ]]; then
  read -r -p "Invite code for ${NEW_PDS_HOST} (optional): " INVITE_CODE || true
fi
if [[ -z "${PLC_TOKEN:-}" ]]; then
  read -r -p "PLC migration token (from old PDS email), or leave blank to skip PLC step for now: " PLC_TOKEN || true
fi

TMPDIR_MANUAL=$(mktemp -d 2>/dev/null || mktemp -d -t alteran-migrate)
cleanup() { rm -rf "${TMPDIR_MANUAL}" || true; }
trap cleanup EXIT

STATE_FILE="$(state_file_path)"

# Helper: fetch access token from a refresh token
access_from_refresh() { # $1=host $2=refresh
  local host="$1" refresh="$2"
  curl -fsS -X POST "${host}/xrpc/com.atproto.server.refreshSession" \
    -H "Authorization: Bearer ${refresh}" \
    -H "Origin: ${host}" \
    -H "Content-Length: 0" \
  | jq -r .accessJwt
}

# Helper: HTTP status check wrapper for binary posts
post_car() { # $1=host $2=access $3=path $4=carpath
  curl -fsS -X POST "$1/xrpc/$3" \
    -H "Authorization: Bearer $2" \
    -H "Content-Type: application/vnd.ipld.car" \
    --data-binary @"$4"
}

# --- Step 1: Login to OLD PDS (full auth) ---
title "[1/9] Login to source PDS"
set +e
if [[ -n "${OLD_AUTH_FACTOR:-}" ]]; then
  goat account login --username "${OLD_IDENTIFIER}" --app-password "${OLD_PASSWORD}" --pds-host "${OLD_PDS_HOST}" --auth-factor-token "${OLD_AUTH_FACTOR}"
else
  goat account login --username "${OLD_IDENTIFIER}" --app-password "${OLD_PASSWORD}" --pds-host "${OLD_PDS_HOST}"
fi
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  echo "Failed to login to source PDS" >&2; exit 1
fi

OLD_REFRESH=$(jq -r .session_token "${STATE_FILE}")
OLD_SESSION_DID=$(jq -r .did "${STATE_FILE}")
if [[ -z "${OLD_REFRESH}" || "${OLD_REFRESH}" == "null" ]]; then
  echo "Could not read old refresh token from ${STATE_FILE}" >&2; exit 1
fi
if [[ -z "${OLD_SESSION_DID}" || "${OLD_SESSION_DID}" == "null" ]]; then
  echo "Could not read old session DID from ${STATE_FILE}" >&2; exit 1
fi

# Ensure the DID used for createAccount matches the DID that will sign service-auth
if [[ "${DID}" != "${OLD_SESSION_DID}" ]]; then
  warn "Provided DID (${DID}) does not match logged-in DID (${OLD_SESSION_DID}). Using ${OLD_SESSION_DID} for createAccount."
  DID="${OLD_SESSION_DID}"
fi

# --- Step 2: Discover Bluesky DID ---
title "[2/9] Discover destination service DID"
NEW_SERVICE_DID=$(curl -fsS "${NEW_PDS_HOST}/xrpc/com.atproto.server.describeServer" | jq -r .did)
echo "Destination DID: ${NEW_SERVICE_DID}"

# --- Step 3: Mint service-auth for createAccount ---
title "[3/9] Create service-auth (createAccount) on old PDS"
SERVICE_JWT=$(goat account service-auth --audience "${NEW_SERVICE_DID}" --endpoint com.atproto.server.createAccount --duration-sec 300)
if [[ -z "${SERVICE_JWT}" ]]; then
  echo "Failed to mint service-auth token" >&2; exit 1
fi

# --- Step 4: Create new account on Bluesky ---
title "[4/9] Create account on ${NEW_PDS_HOST}"
CREATE_ARGS=(
  goat account create
  --pds-host "${NEW_PDS_HOST}"
  --handle "${NEW_HANDLE}"
  --password "${NEW_PASSWORD}"
  --email "${NEW_EMAIL}"
  --existing-did "${DID}"
  --service-auth "${SERVICE_JWT}"
)
if [[ -n "${INVITE_CODE}" ]]; then CREATE_ARGS+=(--invite-code "${INVITE_CODE}"); fi
"${CREATE_ARGS[@]}"
create_rc=$?
if [[ ${create_rc} -ne 0 ]]; then
  warn "goat account create failed; attempting direct request for diagnostics..."
  CREATE_BODY=$(jq -n --arg handle "${NEW_HANDLE}" --arg email "${NEW_EMAIL}" --arg pass "${NEW_PASSWORD}" --arg did "${DID}" '{handle:$handle,email:$email,password:$pass,did:$did}')
  set +e
  CURL_OUT=$(curl -sS -X POST "${NEW_PDS_HOST}/xrpc/com.atproto.server.createAccount" \
    -H "Authorization: Bearer ${SERVICE_JWT}" \
    -H "Content-Type: application/json" \
    -d "${CREATE_BODY}" 2>&1)
  CURL_STATUS=$?
  set -e
  echo "--- createAccount raw response ---"
  echo "${CURL_OUT}" | sed 's/.*/  &/'
  echo "----------------------------------"
  exit 1
fi

# --- Step 5: Login to new PDS & obtain access token ---
title "[5/9] Login to destination PDS"
goat account login --username "${NEW_HANDLE}" --app-password "${NEW_PASSWORD}" --pds-host "${NEW_PDS_HOST}"
NEW_REFRESH=$(jq -r .session_token "${STATE_FILE}")
if [[ -z "${NEW_REFRESH}" || "${NEW_REFRESH}" == "null" ]]; then
  echo "Could not read new refresh token from ${STATE_FILE}" >&2; exit 1
fi
NEW_ACCESS=$(access_from_refresh "${NEW_PDS_HOST}" "${NEW_REFRESH}")

# --- Step 6: Export repo from OLD and import into NEW ---
title "[6/9] Export repo from old PDS and import into Bluesky"
REPO_CAR="${TMPDIR_MANUAL}/repo.car"
info "Downloading repo from ${OLD_PDS_HOST} for ${DID}"
curl -fsS "${OLD_PDS_HOST}/xrpc/com.atproto.sync.getRepo?did=${DID}" -o "${REPO_CAR}"
info "Importing repo (${REPO_CAR}) into ${NEW_PDS_HOST}"
post_car "${NEW_PDS_HOST}" "${NEW_ACCESS}" com.atproto.repo.importRepo "${REPO_CAR}" >/dev/null

# --- Step 7: Transfer missing blobs ---
title "[7/9] Transfer blobs"
while true; do
  MISSING_JSON=$(curl -fsS -H "Authorization: Bearer ${NEW_ACCESS}" "${NEW_PDS_HOST}/xrpc/com.atproto.repo.listMissingBlobs?limit=200")
  COUNT=$(printf "%s" "${MISSING_JSON}" | jq '.blobs | length')
  if [[ "${COUNT}" -eq 0 ]]; then
    info "No missing blobs remaining"; break
  fi
  info "Found ${COUNT} missing blobs; transferring..."
  mapfile -t CIDS < <(printf "%s" "${MISSING_JSON}" | jq -r '.blobs[].cid')
  for cid in "${CIDS[@]}"; do
    BLOB_TMP="${TMPDIR_MANUAL}/blob_${cid}"
    set +e
    curl -fsS "${OLD_PDS_HOST}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${cid}" -o "${BLOB_TMP}"
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then warn "Failed to fetch blob ${cid} from old PDS"; continue; fi
    set +e
    curl -fsS -X POST "${NEW_PDS_HOST}/xrpc/com.atproto.repo.uploadBlob" \
      -H "Authorization: Bearer ${NEW_ACCESS}" \
      -H "Content-Type: application/octet-stream" \
      --data-binary @"${BLOB_TMP}" >/dev/null
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then warn "Failed to upload blob ${cid} to new PDS"; fi
  done
done

# --- Step 8: Best-effort preferences migration ---
title "[8/9] Migrate preferences (best effort)"
set +e
OLD_ACCESS=$(access_from_refresh "${OLD_PDS_HOST}" "${OLD_REFRESH}")
PREFS=$(curl -fsS -H "Authorization: Bearer ${OLD_ACCESS}" "${OLD_PDS_HOST}/xrpc/app.bsky.actor.getPreferences")
rc=$?
set -e
if [[ $rc -ne 0 || -z "${PREFS}" ]]; then
  warn "Skipping preferences migration (endpoint unavailable)"
else
  PREF_BODY=$(printf "%s" "${PREFS}" | jq '{preferences: .preferences // .data.preferences // []}')
  set +e
  curl -fsS -X POST "${NEW_PDS_HOST}/xrpc/app.bsky.actor.putPreferences" \
    -H "Authorization: Bearer ${NEW_ACCESS}" \
    -H "Content-Type: application/json" \
    -d "${PREF_BODY}" >/dev/null
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then warn "Preferences migration failed (continuing)"; else info "Preferences migrated"; fi
fi

# --- Step 9: PLC operation + activation + old deactivation ---
title "[9/9] Rotate DID to Bluesky and finalize"

# Prepare recommended PLC op (needs NEW session)
goat account login --username "${NEW_HANDLE}" --app-password "${NEW_PASSWORD}" --pds-host "${NEW_PDS_HOST}" >/dev/null
PLC_OP_JSON="${TMPDIR_MANUAL}/plc-op.json"
goat account plc recommended >"${PLC_OP_JSON}"

# Optionally insert a user-provided recovery key at the front of rotationKeys
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

if [[ -n "${PLC_TOKEN}" ]]; then
  # Sign with OLD PDS
  goat account login --username "${OLD_IDENTIFIER}" --app-password "${OLD_PASSWORD}" --pds-host "${OLD_PDS_HOST}" >/dev/null
  PLC_OP_SIGNED_JSON="${TMPDIR_MANUAL}/plc-op.signed.json"
  goat account plc sign --token "${PLC_TOKEN}" "${PLC_OP_JSON}" >"${PLC_OP_SIGNED_JSON}"

  # Submit with NEW PDS
  goat account login --username "${NEW_HANDLE}" --app-password "${NEW_PASSWORD}" --pds-host "${NEW_PDS_HOST}" >/dev/null
  goat account plc submit "${PLC_OP_SIGNED_JSON}"
else
  warn "PLC token not provided; skipping DID rotation. Run later: goat account plc request-token/sign/submit"
fi

# Activate new account
goat account activate

# Print status for visibility
info "Account status on ${NEW_PDS_HOST}:"
curl -fsS -H "Authorization: Bearer ${NEW_ACCESS}" "${NEW_PDS_HOST}/xrpc/com.atproto.server.checkAccountStatus" | jq '.' || true

# Deactivate old account (best effort)
set +e
curl -fsS -X POST "${OLD_PDS_HOST}/xrpc/com.atproto.server.deactivateAccount" \
  -H "Authorization: Bearer ${OLD_ACCESS}" \
  -H "Content-Type: application/json" -d '{}' >/dev/null
set -e

echo
echo "Migration complete. Verify on ${NEW_PDS_HOST}:"
echo "  goat account status"
echo "If DID rotation was skipped, complete later with PLC commands."
