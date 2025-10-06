#!/usr/bin/env bash
set -euo pipefail

# Interactive helper that signs into your current Alteran PDS account and
# migrates it back to Bluesky's main PDS (https://bsky.social).

GOAT_BIN="${GOAT_BINARY:-goat}"
DEST_PDS_HOST="https://bsky.social"

if [[ ! -x "${GOAT_BIN}" ]]; then
  echo "Unable to find executable goat binary at ${GOAT_BIN}" >&2
  echo "Set GOAT_BINARY to point at your build (e.g. GOAT_BINARY=./goat/goat)." >&2
  exit 1
fi

echo "Alteran → Bluesky Migration Wizard"
echo "----------------------------------"
echo "This script will:"
echo "  1. Log into your current PDS using the goat CLI."
echo "  2. Run the interactive migration back to ${DEST_PDS_HOST}."
echo
echo "Nothing will be sent until you confirm the collected details."
echo

read -r -p "Current PDS host (e.g. https://pds.example.com): " CURRENT_PDS_HOST
if [[ -z "${CURRENT_PDS_HOST}" ]]; then
  echo "A source PDS host is required." >&2
  exit 1
fi

read -r -p "Current handle or DID: " CURRENT_IDENTIFIER
if [[ -z "${CURRENT_IDENTIFIER}" ]]; then
  echo "An account handle or DID is required." >&2
  exit 1
fi

read -r -p "Desired handle on ${DEST_PDS_HOST} (e.g. rawkode.dev): " TARGET_HANDLE
if [[ -z "${TARGET_HANDLE}" ]]; then
  echo "A target handle is required." >&2
  exit 1
fi

echo -n "Full account password for ${CURRENT_IDENTIFIER} (input hidden): " >&2
IFS_OLD=${IFS}
IFS= read -rs CURRENT_PASSWORD
IFS=${IFS_OLD}
echo >&2
if [[ -z "${CURRENT_PASSWORD}" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

echo -n "Password to use on ${DEST_PDS_HOST} (leave blank to reuse current password): " >&2
IFS_OLD=${IFS}
IFS= read -rs TARGET_PASSWORD
IFS=${IFS_OLD}
echo >&2
if [[ -z "${TARGET_PASSWORD}" ]]; then
  TARGET_PASSWORD="${CURRENT_PASSWORD}"
fi

read -r -p "Email address for the account on ${DEST_PDS_HOST}: " TARGET_EMAIL
if [[ -z "${TARGET_EMAIL}" ]]; then
  echo "An email address is required for Bluesky account creation." >&2
  exit 1
fi

read -r -p "PLC migration token from your current PDS: " PLC_TOKEN
if [[ -z "${PLC_TOKEN}" ]]; then
  echo "A PLC token is required to authorize the migration." >&2
  exit 1
fi

read -r -p "Invite code for ${DEST_PDS_HOST} (optional): " INVITE_CODE

echo
echo "Summary"
echo "-------"
echo " Source PDS         : ${CURRENT_PDS_HOST}"
echo " Destination PDS    : ${DEST_PDS_HOST}"
echo " Account identifier : ${CURRENT_IDENTIFIER}"
echo " Target handle      : ${TARGET_HANDLE}"
echo " Email              : ${TARGET_EMAIL}"
if [[ -n "${INVITE_CODE}" ]]; then
  echo " Invite code        : ${INVITE_CODE}"
else
  echo " Invite code        : (none)"
fi
echo
read -r -p "Proceed with migration? [y/N]: " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
  echo "Aborted by user." >&2
  exit 1
fi

echo
echo "[1/2] Logging into source PDS..."
"${GOAT_BIN}" account login \
  --username "${CURRENT_IDENTIFIER}" \
  --app-password "${CURRENT_PASSWORD}" \
  --pds-host "${CURRENT_PDS_HOST}"

echo "[2/2] Migrating account to ${DEST_PDS_HOST}..."
migrate_cmd=(
  "${GOAT_BIN}" account migrate
  --pds-host "${DEST_PDS_HOST}"
  --new-handle "${TARGET_HANDLE}"
  --new-password "${TARGET_PASSWORD}"
  --new-email "${TARGET_EMAIL}"
  --plc-token "${PLC_TOKEN}"
)

if [[ -n "${INVITE_CODE}" ]]; then
  migrate_cmd+=(--invite-code "${INVITE_CODE}")
fi

"${migrate_cmd[@]}"

echo
echo "Migration complete."
echo "You can verify the new session with:"
echo "  ${GOAT_BIN} account status"
echo "and re-authenticate with Bluesky clients as needed."
