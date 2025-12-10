# Security Considerations: Token in URL

## Current Implementation

The current authentication system stores the session token in the URL query parameter `_token` to work around limitations with cookies in cross-origin iframes on HTTP.

## Security Implications

### ⚠️ Risks of Tokens in URLs

1. **Browser History**: Tokens are stored in browser history and can be accessed by anyone with access to the browser
2. **Server Logs**: URLs (including query parameters) are typically logged by web servers
3. **Referrer Headers**: Tokens can leak to external sites via HTTP referrer headers
4. **Accidental Sharing**: Users might accidentally share URLs containing tokens
5. **Screen Sharing**: Tokens may be visible in screen recordings or screenshots

### ✅ Mitigations in Place

1. **Base64 Encoding**: The token is base64-encoded session data (not the raw OIDC token)
2. **Short Expiration**: Session tokens expire after 7 days
3. **Development Only**: This approach is primarily for development/testing scenarios
4. **localStorage Backup**: Token is also stored in localStorage for client-side API calls

## Recommendations

### For Development (Current Setup)
- ✅ Acceptable for local development and testing
- ✅ Works in HTTP iframes where cookies don't work
- ⚠️ Be cautious about sharing URLs or screenshots

### For Production

**Option 1: Use HTTPS (Recommended)**
- Enable HTTPS in production
- Set cookies with `sameSite: 'none'` and `secure: true`
- Tokens will work in cookies, no need for URL tokens

**Option 2: Session Storage**
- Use `sessionStorage` instead of `localStorage` (cleared on tab close)
- Implement proper session management with server-side sessions
- Use short-lived tokens (e.g., 15-30 minutes)

**Option 3: PostMessage API**
- If in iframe, use `postMessage` to communicate with parent window
- Parent window handles authentication
- No tokens in URLs

## Best Practices

1. **Never commit tokens to version control**
2. **Rotate tokens regularly**
3. **Use HTTPS in production**
4. **Implement proper session management**
5. **Monitor for token leaks in logs**
6. **Educate users about not sharing URLs**

## Current Token Format

The token is base64-encoded JSON containing:
```json
{
  "userId": "...",
  "uuid": "...",
  "email": "...",
  "name": "...",
  "tags": [],
  "createdAt": 1234567890,
  "expiresAt": 1234567890
}
```

This is **not** the OIDC access token (which expires in 5 minutes), but a session token that lasts 7 days.

