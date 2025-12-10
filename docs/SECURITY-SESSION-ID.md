# Secure Session Management

## Overview

The authentication system uses a **session ID-based approach** that works securely in both development and production environments, including cross-origin iframes.

## How It Works

### Session Creation
1. User logs in with OIDC access token
2. Server validates token and creates a session in server-side store
3. Server generates a **cryptographically secure random session ID** (64 hex characters)
4. Session data (user info, tags, etc.) is stored **server-side only**
5. Only the session ID is returned to the client

### Session Storage
- **Server-side**: Session data stored in memory (can be upgraded to Redis/database)
- **Client-side**: Only the session ID is stored in:
  - Cookie: `admin_session_id` (preferred, works in same-origin and HTTPS iframes)
  - localStorage: `admin_session_id` (for client-side API calls)
  - URL parameter: `_session` (fallback for HTTP iframes where cookies don't work)

### Session Validation
1. Client sends session ID via cookie, URL parameter, or Authorization header
2. Server looks up session data from store using session ID
3. Server validates expiration and returns session data
4. If session not found or expired, user is redirected to login

## Security Benefits

### ✅ Advantages Over Previous Approach

1. **No Sensitive Data in URLs**: Only a random session ID is in the URL, not full user data
2. **Server-Side Storage**: Session data never leaves the server
3. **Automatic Expiration**: Sessions expire after 7 days, checked server-side
4. **Session Revocation**: Sessions can be invalidated server-side immediately
5. **Smaller Attack Surface**: Session ID is just an identifier, not decryptable user data

### 🔒 Security Features

- **Cryptographically Secure IDs**: Session IDs are generated using `crypto.randomBytes(32)`
- **HttpOnly Cookies**: Prevents XSS attacks from accessing session ID
- **Secure Cookies (HTTPS)**: Uses `sameSite: 'none'` and `secure: true` for iframe support
- **Automatic Cleanup**: Expired sessions are automatically removed
- **No Data Leakage**: Full session data never exposed to client

## Environment Support

### Production (HTTPS)
- ✅ Cookies work with `sameSite: 'none'` and `secure: true`
- ✅ Works in cross-origin iframes
- ✅ Session ID in cookie (preferred)
- ✅ No need for URL parameters

### Development (HTTP)
- ⚠️ Cookies with `sameSite: 'lax'` don't work in cross-origin iframes
- ✅ Session ID in URL parameter `_session` (fallback)
- ✅ Still secure - only session ID, not full data
- ✅ Works in iframes via WorkAdventure

## Migration from Legacy System

The system maintains backward compatibility:
- Legacy `_token` parameter still supported
- Legacy `user_session` cookie still supported
- Old tokens are automatically migrated/parsed

## Production Recommendations

1. **Use Redis for Session Store**: Replace in-memory store with Redis for:
   - Persistence across server restarts
   - Multi-server deployments
   - Better performance at scale

2. **Enable HTTPS**: Required for secure cookies in iframes

3. **Session Rotation**: Consider rotating session IDs periodically

4. **Monitoring**: Log failed session lookups for security analysis

## Implementation Details

### Session Store
- Location: `lib/session-store.ts`
- Current: In-memory Map
- Recommended: Redis or database-backed

### Session ID Format
- 64 hexadecimal characters (32 bytes)
- Example: `a1b2c3d4e5f6...` (64 chars)

### Session Data Structure
```typescript
{
  userId: string;
  uuid: string;
  email: string | null;
  name: string | null;
  tags: string[];
  createdAt: number;
  expiresAt: number;
}
```

## Comparison: Old vs New

| Aspect | Old (Token in URL) | New (Session ID) |
|--------|-------------------|------------------|
| URL Content | Full session data (base64) | Random session ID only |
| Security | ⚠️ Sensitive data exposed | ✅ Only identifier exposed |
| Server Storage | None (stateless) | ✅ Server-side store |
| Revocation | ❌ Can't revoke | ✅ Can revoke immediately |
| Size | Large (full data) | Small (64 chars) |
| Iframe Support | ✅ Works | ✅ Works |
| Production Ready | ⚠️ Not ideal | ✅ Production ready |

