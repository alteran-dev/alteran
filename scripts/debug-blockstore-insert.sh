#!/usr/bin/env bash

set -euo pipefail

# Inserts a single block into the remote D1 blockstore table so we can inspect
# errors coming back from Cloudflare. Usage:
#   CID=bafy... BYTES=base64 ./scripts/debug-blockstore-insert.sh
# or rely on the defaults below, which reproduce the failing row from the
# migration attempt.

REPO_ROOT=$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-"$REPO_ROOT/.config"}"

CID_DEFAULT='bafyreie7grolhuzbfbeacmsqtq3h6aj6k2nw6l7xtfpyy7widblraqrl5y'
BYTES_DEFAULT='o2UkdHlwZXJhcHAuYnNreS5mZWVkLmxpa2Vnc3ViamVjdKJjY2lkeDtiYWZ5cmVpZTRhYjZxNHJlbGRkdWUzNGx5dnpoNHZic2tmdzV6cHRzNDZic2l6bWc1NndjNDc2bHhmdWN1cml4RmF0Oi8vZGlkOnBsYzo2ZHRvdnVxdWxwMnp4bWt1M3lzbmQyY24vYXBwLmJza3kuZmVlZC5wb3N0LzNsb2xiZDYza2VzMjZpY3JlYXRlZEF0eBgyMDI1LTA1LTA3VDExOjE0OjQ5LjM2Mlo='

CID=${CID:-$CID_DEFAULT}
BYTES=${BYTES:-$BYTES_DEFAULT}

SQL=$'INSERT INTO blockstore (cid, bytes)\n  VALUES (?1, ?2)\n  ON CONFLICT DO NOTHING;'

echo "Running remote insert for cid=$CID"

bun run wrangler d1 execute alteran --remote --command "$SQL" --param "$CID" --param "$BYTES"
