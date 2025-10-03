#!/usr/bin/env bash
set -euo pipefail

BASE=${1:-http://localhost:4321}

echo "==> GET /health"
curl -sSf "$BASE/health" -o /dev/null && echo ok

echo "==> Bootstrap DB"
curl -sSf -X POST "$BASE/debug/db/bootstrap" -o /dev/null && echo ok

echo "==> Create session"
RES=$(curl -sSf -X POST "$BASE/xrpc/com.atproto.server.createSession" \
  -H 'content-type: application/json' \
  --data '{"identifier":"user","password":"pwd"}')
ACCESS=$(echo "$RES" | sed -n 's/.*"accessJwt":"\([^"]*\)".*/\1/p')
echo "accessJwt: ${ACCESS:0:16}..."

echo "==> Create record"
curl -sSf -X POST "$BASE/xrpc/com.atproto.repo.createRecord" \
  -H 'content-type: application/json' -H "authorization: Bearer $ACCESS" \
  --data '{"collection":"app.bsky.feed.post","record":{"text":"hello"}}' -o /dev/null && echo ok

echo "==> Get head"
curl -sSf "$BASE/xrpc/com.atproto.sync.getHead" && echo

echo "Smoke test complete"

