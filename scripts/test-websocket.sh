#!/usr/bin/env bash

# Test subscribeRepos WebSocket connection
# This should stay connected indefinitely without reconnecting

echo "Testing WebSocket connection to subscribeRepos..."
echo "If the fix is working, you should see:"
echo "  1. Initial connection message"
echo "  2. Info frame (binary data)"
echo "  3. Connection stays open (no reconnects)"
echo ""
echo "Press Ctrl+C to exit"
echo ""

# Test with cursor parameter (replay from beginning)
echo "Testing with cursor=0 (replay all events)..."
, websocat "wss://rawkode.dev/xrpc/com.atproto.sync.subscribeRepos?cursor=0" --binary

# If above exits, test without cursor
echo ""
echo "Connection closed. Testing without cursor..."
, websocat "wss://rawkode.dev/xrpc/com.atproto.sync.subscribeRepos" --binary
