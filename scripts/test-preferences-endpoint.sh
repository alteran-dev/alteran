#!/bin/bash

# Test app.bsky.actor.getPreferences endpoint
# This script helps verify if the preferences endpoint is working on your PDS

set -e

PDS_URL="${PDS_URL:-https://rawkode.dev}"
HANDLE="${HANDLE:-rawkode.dev}"
PASSWORD="${PASSWORD}"

if [ -z "$PASSWORD" ]; then
    echo "Error: PASSWORD environment variable must be set"
    echo "Usage: PASSWORD='your-password' ./test-preferences-endpoint.sh"
    exit 1
fi

echo "Testing app.bsky.actor.getPreferences endpoint..."
echo "PDS URL: $PDS_URL"
echo "Handle: $HANDLE"
echo ""

# Step 1: Create a session to get a fresh access token
echo "Step 1: Creating session..."
SESSION_RESPONSE=$(curl -s -X POST "$PDS_URL/xrpc/com.atproto.server.createSession" \
    -H "Content-Type: application/json" \
    -d "{\"identifier\":\"$HANDLE\",\"password\":\"$PASSWORD\"}")

ACCESS_TOKEN=$(echo "$SESSION_RESPONSE" | jq -r '.accessJwt // empty')
DID=$(echo "$SESSION_RESPONSE" | jq -r '.did // empty')

if [ -z "$ACCESS_TOKEN" ]; then
    echo "❌ Failed to create session"
    echo "Response: $SESSION_RESPONSE"
    exit 1
fi

echo "✅ Session created successfully"
echo "DID: $DID"
echo "Access Token: ${ACCESS_TOKEN:0:50}..."
echo ""

# Step 2: Test getPreferences endpoint
echo "Step 2: Testing app.bsky.actor.getPreferences..."
PREFS_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
    "$PDS_URL/xrpc/app.bsky.actor.getPreferences" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json")

HTTP_STATUS=$(echo "$PREFS_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
RESPONSE_BODY=$(echo "$PREFS_RESPONSE" | sed '/HTTP_STATUS:/d')

echo "HTTP Status: $HTTP_STATUS"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ SUCCESS: Preferences endpoint is working!"
    echo ""
    echo "Response:"
    echo "$RESPONSE_BODY" | jq '.'

    # Check if preferences array exists
    PREFS_COUNT=$(echo "$RESPONSE_BODY" | jq '.preferences | length // 0')
    echo ""
    echo "Number of preferences: $PREFS_COUNT"

    exit 0
else
    echo "❌ FAILED: Preferences endpoint returned error"
    echo ""
    echo "Response:"
    echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"

    # Common issues to check
    echo ""
    echo "Common issues to investigate:"
    echo "- 401: Authentication/authorization issue"
    echo "- 404: Endpoint not implemented or route not registered"
    echo "- 500: Server error - check PDS logs"
    echo "- Check if the endpoint handler is properly registered in your PDS"
    echo "- Verify OAuth scope requirements are met"

    exit 1
fi