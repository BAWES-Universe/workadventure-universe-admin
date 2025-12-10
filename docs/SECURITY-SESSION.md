# Session Security Architecture

## Overview

This document explains the security architecture of the session management system, designed to work in both development (HTTP) and production (HTTPS) environments, including iframe scenarios.

## Security Model

### Session Storage

1. **Server-Side Session Store (Redis/In-Memory)**
   - Stores full session data server-side
   - Session ID is a random 64-character hex string (32 bytes of entropy)
   - Session data includes: userId, uuid, email, name, tags, expiration
   - Sessions expire after 7 days

2. **Client-Side Storage**
   - `sessionToken`: Base64-encoded JSON containing full session data
   - Stored in `localStorage` (works in iframes)
   - Also passed in URL query parameter `_token` for server-side access
   - **Security Note**: The token contains session data, not credentials. It's similar to a session cookie but works in HTTP iframes.

3. **Cookies**
   - `user_session`: JSON-encoded session data (preferred method)
   - `admin_session_id`: Session ID for Redis lookup (fallback)
   - Cookies work in same-origin and HTTPS iframes, but not in HTTP iframes

## Authentication Flow

### Initial Login

1. User provides OIDC `accessToken` to `/api/auth/login`
2. Server validates token with OIDC provider
3. Server creates session in Redis/store
4. Server returns:
   - `sessionToken`: Base64-encoded session data (for URL/localStorage)
   - `sessionId`: Random session ID (for Redis lookup)
   - Sets `user_session` cookie (if cookies work)
5. Client stores `sessionToken` in localStorage
6. Client redirects with `_token` in URL

### Subsequent Requests

1. **Middleware checks in order:**
   - `user_session` cookie (preferred - most secure)
   - `admin_session_id` cookie (fallback)
   - `_token` URL parameter (for HTTP iframes)
   - `_session` URL parameter (fallback)
   - Authorization header (for API requests)

2. **If session found in URL but not cookie:**
   - Middleware validates the token
   - Sets `user_session` cookie for future requests
   - This ensures cookies work on subsequent navigations

3. **Session Validation:**
   - Parses session data (JSON from cookie or base64 from URL)
   - Checks expiration
   - Validates userId exists in database

## Security Considerations

### ✅ Secure Aspects

1. **Session Expiration**: Sessions expire after 7 days
2. **Server-Side Validation**: All session validation happens server-side
3. **No Credentials in Token**: Token contains session data, not passwords or OIDC tokens
4. **HttpOnly Cookies**: When cookies work, they're HttpOnly (not accessible to JavaScript)
5. **Secure Cookies in HTTPS**: Cookies use `Secure` and `SameSite=None` in production
6. **Random Session IDs**: 32 bytes of entropy (64 hex characters)

### ⚠️ Security Trade-offs for HTTP Iframes

1. **URL Token Exposure**
   - **Risk**: Session token visible in URL (browser history, server logs, referrer headers)
   - **Mitigation**: 
     - Token contains session data, not credentials
     - Sessions expire after 7 days
     - Tokens are single-use in practice (converted to cookies)
     - Consider using shorter-lived tokens for iframe scenarios

2. **localStorage Access**
   - **Risk**: Accessible to JavaScript (XSS vulnerability)
   - **Mitigation**:
     - Token contains session data, not credentials
     - Server validates all requests
     - Consider Content Security Policy (CSP) headers

3. **No HttpOnly for localStorage**
   - **Risk**: JavaScript can access token
   - **Mitigation**: Same as above - token doesn't contain credentials

### 🔒 Recommended Security Enhancements

1. **Short-Lived Tokens for Iframes**
   - Consider 15-30 minute tokens for iframe scenarios
   - Require re-authentication for sensitive operations

2. **Token Rotation**
   - Rotate session tokens on each use
   - Invalidate old tokens

3. **Content Security Policy**
   - Implement CSP headers to prevent XSS
   - Restrict inline scripts

4. **Rate Limiting**
   - Limit login attempts
   - Limit session creation

5. **Audit Logging**
   - Log all authentication events
   - Monitor for suspicious activity

## Comparison: Cookie vs URL Token

| Aspect | Cookie | URL Token |
|--------|--------|-----------|
| **Security** | ✅ More secure (HttpOnly) | ⚠️ Less secure (visible in URL) |
| **HTTP Iframes** | ❌ Doesn't work | ✅ Works |
| **HTTPS Iframes** | ✅ Works (SameSite=None) | ✅ Works |
| **Browser History** | ✅ Not stored | ❌ Stored |
| **Server Logs** | ✅ Not logged | ❌ Logged in URLs |
| **XSS Protection** | ✅ HttpOnly | ❌ Accessible to JS |

## Best Practices

1. **Always prefer cookies when possible** (HTTPS, same-origin)
2. **Use URL tokens only when necessary** (HTTP iframes)
3. **Convert URL tokens to cookies** (middleware does this automatically)
4. **Set short expiration** for iframe tokens if possible
5. **Implement CSP** to prevent XSS
6. **Monitor and log** authentication events
7. **Use HTTPS in production** to enable secure cookies

## Current Implementation

The current implementation:
- ✅ Uses cookies when available (most secure)
- ✅ Falls back to URL tokens for HTTP iframes (functional but less secure)
- ✅ Converts URL tokens to cookies automatically
- ✅ Validates all sessions server-side
- ✅ Expires sessions after 7 days
- ⚠️ URL tokens visible in browser history/logs (trade-off for HTTP iframe support)

## Future Improvements

1. Implement token rotation
2. Add shorter expiration for iframe tokens
3. Implement CSP headers
4. Add audit logging
5. Consider using postMessage API for iframe communication instead of URL tokens

