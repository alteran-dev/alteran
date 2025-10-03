#!/usr/bin/env bash
set -euo pipefail

# Usage: PDS_D1_NAME=<db-name> ./scripts/migrate-d1.sh

if [[ -z "${PDS_D1_NAME:-}" ]]; then
  echo "PDS_D1_NAME not set" >&2
  exit 1
fi

shopt -s nullglob
files=(drizzle/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No migrations found under drizzle/" >&2
  exit 0
fi

echo "Applying ${#files[@]} migrations to D1 database: ${PDS_D1_NAME}" >&2
for f in "${files[@]}"; do
  echo "→ ${f}" >&2
  bunx wrangler d1 execute "${PDS_D1_NAME}" --remote --file "${f}"
done
echo "Done" >&2

