#!/bin/bash

# Test all critical XRPC endpoints for PDS
# This script systematically tests Phase 1 critical endpoints from the checklist

set -e

PDS_URL="${PDS_URL:-https://rawkode.dev}"
HANDLE="${HANDLE:-rawkode.dev}"
PASSWORD="${PASSWORD}"

if [ -z "$PASSWORD" ]; then
    echo "Error: PASSWORD environment variable must be set"
    echo "Usage: PASSWORD='your-password' ./test-critical-endpoints.sh"
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results tracking
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected_status="${5:-200}"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Test #$TOTAL_TESTS: $name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if [ "$method" = "GET" ]; then
        RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
            "$PDS_URL/xrpc/$endpoint" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Accept: application/json")
    else
        RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
            -X "$method" \
            "$PDS_URL/xrpc/$endpoint" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -H "Accept: application/json" \
            -d "$data")
    fi

    HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
    RESPONSE_BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')

    if [ "$HTTP_STATUS" = "$expected_status" ]; then
        echo -e "${GREEN}✅ PASSED${NC} - HTTP $HTTP_STATUS"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
    else
        echo -e "${RED}❌ FAILED${NC} - Expected HTTP $expected_status, got HTTP $HTTP_STATUS"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"
    fi
}

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         XRPC Critical Endpoints Test Suite                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "PDS URL: $PDS_URL"
echo "Handle: $HANDLE"
echo ""

# Phase 0: Create Session
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 0: Authentication"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

SESSION_RESPONSE=$(curl -s -X POST "$PDS_URL/xrpc/com.atproto.server.createSession" \
    -H "Content-Type: application/json" \
    -d "{\"identifier\":\"$HANDLE\",\"password\":\"$PASSWORD\"}")

ACCESS_TOKEN=$(echo "$SESSION_RESPONSE" | jq -r '.accessJwt // empty')
REFRESH_TOKEN=$(echo "$SESSION_RESPONSE" | jq -r '.refreshJwt // empty')
DID=$(echo "$SESSION_RESPONSE" | jq -r '.did // empty')

if [ -z "$ACCESS_TOKEN" ]; then
    echo -e "${RED}❌ Failed to create session${NC}"
    echo "Response: $SESSION_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✅ Session created successfully${NC}"
echo "DID: $DID"
echo "Access Token: ${ACCESS_TOKEN:0:50}..."
echo "Refresh Token: ${REFRESH_TOKEN:0:50}..."

# Phase 1: Session Management
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 1: Session Management (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "com.atproto.server.getSession" \
    "GET" \
    "com.atproto.server.getSession"

test_endpoint \
    "com.atproto.server.refreshSession" \
    "POST" \
    "com.atproto.server.refreshSession" \
    ""

# Phase 2: Profile Operations
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 2: Profile Operations (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "app.bsky.actor.getProfile" \
    "GET" \
    "app.bsky.actor.getProfile?actor=$HANDLE"

test_endpoint \
    "app.bsky.actor.getPreferences" \
    "GET" \
    "app.bsky.actor.getPreferences"

# Phase 3: Feed Operations
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 3: Feed Operations (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "app.bsky.feed.getTimeline" \
    "GET" \
    "app.bsky.feed.getTimeline?limit=10"

test_endpoint \
    "app.bsky.feed.getAuthorFeed" \
    "GET" \
    "app.bsky.feed.getAuthorFeed?actor=$HANDLE&limit=10"

# Phase 4: Identity Resolution
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 4: Identity Resolution (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "com.atproto.identity.resolveHandle" \
    "GET" \
    "com.atproto.identity.resolveHandle?handle=$HANDLE"

# Phase 5: Repository Operations
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 5: Repository Operations (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "com.atproto.repo.describeRepo" \
    "GET" \
    "com.atproto.repo.describeRepo?repo=$DID"

test_endpoint \
    "com.atproto.repo.listRecords" \
    "GET" \
    "com.atproto.repo.listRecords?repo=$DID&collection=app.bsky.feed.post&limit=10"

# Phase 6: Notification Operations
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 6: Notification Operations (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "app.bsky.notification.listNotifications" \
    "GET" \
    "app.bsky.notification.listNotifications?limit=10"

test_endpoint \
    "app.bsky.notification.getUnreadCount" \
    "GET" \
    "app.bsky.notification.getUnreadCount"

# Phase 7: Graph Operations
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 7: Graph Operations (CRITICAL)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint \
    "app.bsky.graph.getFollowers" \
    "GET" \
    "app.bsky.graph.getFollowers?actor=$HANDLE&limit=10"

test_endpoint \
    "app.bsky.graph.getFollows" \
    "GET" \
    "app.bsky.graph.getFollows?actor=$HANDLE&limit=10"

# Summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                     Test Summary                           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Tests:  $TOTAL_TESTS"
echo -e "${GREEN}Passed:       $PASSED_TESTS${NC}"
echo -e "${RED}Failed:       $FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some tests failed. Check the output above for details.${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Check PDS logs for error details"
    echo "2. Verify endpoint implementations in your PDS code"
    echo "3. Check database schema and migrations"
    echo "4. Verify OAuth scopes and authentication middleware"
    exit 1
fi