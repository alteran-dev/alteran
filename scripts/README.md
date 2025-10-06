# XRPC Endpoint Testing Scripts

This directory contains scripts to test your PDS (Personal Data Server) XRPC endpoints systematically.

## Scripts

### 1. `test-preferences-endpoint.sh`

Tests the `app.bsky.actor.getPreferences` endpoint specifically.

**Usage:**
```bash
PASSWORD='your-password' ./scripts/test-preferences-endpoint.sh
```

**Environment Variables:**
- `PASSWORD` (required) - Your account password
- `PDS_URL` (optional) - Your PDS URL (default: https://rawkode.dev)
- `HANDLE` (optional) - Your handle (default: rawkode.dev)

**Example:**
```bash
PASSWORD='mypassword' PDS_URL='https://rawkode.dev' HANDLE='rawkode.dev' ./scripts/test-preferences-endpoint.sh
```

### 2. `test-critical-endpoints.sh`

Comprehensive test suite for all Phase 1 critical endpoints from the XRPC checklist.

**Usage:**
```bash
PASSWORD='your-password' ./scripts/test-critical-endpoints.sh
```

**Tests the following endpoint categories:**
- ✅ Session Management (getSession, refreshSession)
- 🔴 Profile Operations (getProfile, getPreferences)
- 🔴 Feed Operations (getTimeline, getAuthorFeed)
- 🔴 Identity Resolution (resolveHandle)
- 🔴 Repository Operations (describeRepo, listRecords)
- 🔴 Notification Operations (listNotifications, getUnreadCount)
- 🔴 Graph Operations (getFollowers, getFollows)

**Output:**
The script provides:
- Color-coded test results (✅ passed, ❌ failed)
- HTTP status codes
- JSON response bodies
- Summary statistics
- Troubleshooting suggestions

## Understanding the Results

### Success (HTTP 200)
```
✅ PASSED - HTTP 200
{
  "preferences": [...]
}
```

### Common Errors

#### 401 Unauthorized
```
❌ FAILED - Expected HTTP 200, got HTTP 401
{"error":"AuthRequired"}
```
**Causes:**
- Expired JWT token
- Invalid authentication
- Missing OAuth scopes

#### 404 Not Found
```
❌ FAILED - Expected HTTP 200, got HTTP 404
{"error":"MethodNotImplemented"}
```
**Causes:**
- Endpoint not implemented in PDS
- Route not registered
- Incorrect endpoint path

#### 500 Internal Server Error
```
❌ FAILED - Expected HTTP 200, got HTTP 500
{"error":"InternalServerError"}
```
**Causes:**
- Database error
- Missing database tables
- Code exception in handler

## Troubleshooting

### If tests fail:

1. **Check PDS logs:**
   ```bash
   # If running PDS in Docker
   docker logs <pds-container-name>

   # If running PDS directly
   tail -f /path/to/pds/logs
   ```

2. **Verify endpoint implementation:**
   - Check if the handler exists in your PDS codebase
   - Look for the endpoint in route registration
   - Verify the lexicon schema matches

3. **Check database:**
   ```bash
   # Connect to your database
   psql -U postgres -d pds

   # Check if required tables exist
   \dt

   # Check preferences table
   SELECT * FROM actor_pref LIMIT 5;
   ```

4. **Verify authentication:**
   - Ensure OAuth middleware is properly configured
   - Check scope requirements for each endpoint
   - Verify JWT validation logic

5. **Compare with official Bluesky:**
   ```bash
   # Test against official Bluesky API
   curl 'https://bsky.social/xrpc/app.bsky.actor.getPreferences' \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

## Next Steps

After running these tests:

1. Document which endpoints are working vs failing
2. Update the [`XRPC_ENDPOINT_CHECKLIST.md`](../XRPC_ENDPOINT_CHECKLIST.md) with results
3. Prioritize fixing critical (🔴) endpoints first
4. Check PDS implementation for missing handlers
5. Verify database schema matches requirements

## Related Documentation

- [XRPC Endpoint Checklist](../XRPC_ENDPOINT_CHECKLIST.md) - Complete list of all endpoints
- [AT Protocol Lexicons](https://github.com/bluesky-social/atproto/tree/main/lexicons) - Official endpoint specifications
- [PDS Documentation](../docs/) - Your PDS implementation docs