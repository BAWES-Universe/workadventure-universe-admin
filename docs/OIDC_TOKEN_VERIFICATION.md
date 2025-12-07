# OIDC Token Verification Guide

This guide explains how to verify OIDC tokens from Authentik (or other OIDC providers) with the Admin API.

## Quick Test

Use the test script to verify a token:

```bash
docker exec admin-api-dev sh -c 'cd /app && npx tsx scripts/test-oidc-token.ts "YOUR_TOKEN_HERE"'
```

Or use the API endpoint:

```bash
# GET request
curl -H "Authorization: Bearer {ADMIN_API_TOKEN}" \
  "http://admin.bawes.localhost/api/auth/verify-token?token=YOUR_TOKEN"

# POST request
curl -X POST -H "Authorization: Bearer {ADMIN_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN"}' \
  "http://admin.bawes.localhost/api/auth/verify-token"
```

## Token Analysis

### Decoded Token Information

From your token, I can see:

- **Issuer**: `https://auth.bawes.net/application/o/universe/`
- **Subject**: `khalid@bawes.net`
- **Email**: `khalid@bawes.net`
- **Name**: `Khalid Al-Mutawa`
- **Username**: `khalidmnet`
- **Groups**: `["authentik Admins"]`
- **Scopes**: `email openid profile`
- **Expiration**: Token has **expired** (exp: 1765137409 = 2025-12-07T19:56:49 UTC)

### Configuration Status

✅ **OIDC Configuration is Correct:**
- `OIDC_ISSUER`: `https://auth.bawes.net/application/o/universe/` ✓
- `OIDC_CLIENT_ID`: `vBTNJ45ZwIwaPLRQMCU4wM9Nuhx8lihcwnaXez15` ✓
- `OIDC_CLIENT_SECRET`: Configured ✓

## Token Expiration

**Important**: Your token has expired. OIDC access tokens typically expire after a short period (usually 1 hour or less).

To test with a valid token:

1. **Get a fresh token from Authentik:**
   - Log in to WorkAdventure again
   - Extract the new access token from the browser
   - Or use Authentik's token endpoint to get a new token

2. **Token expiration check:**
   ```bash
   # The test script will show if token is expired
   docker exec admin-api-dev sh -c 'cd /app && npx tsx scripts/test-oidc-token.ts "NEW_TOKEN"'
   ```

## How Token Validation Works

1. **JWT Decoding**: The token is decoded to extract claims (issuer, subject, expiration, etc.)
2. **OIDC Provider Validation**: The token is validated with the OIDC provider using the `userinfo` endpoint
3. **User Info Retrieval**: If valid, user information is retrieved from the OIDC provider

## Expected Response

### Valid Token

```json
{
  "success": true,
  "decoded": {
    "iss": "https://auth.bawes.net/application/o/universe/",
    "sub": "khalid@bawes.net",
    "email": "khalid@bawes.net",
    "name": "Khalid Al-Mutawa",
    "groups": ["authentik Admins"]
  },
  "userInfo": {
    "sub": "khalid@bawes.net",
    "email": "khalid@bawes.net",
    "name": "Khalid Al-Mutawa",
    "preferred_username": "khalidmnet"
  },
  "tokenInfo": {
    "issuer": "https://auth.bawes.net/application/o/universe/",
    "subject": "khalid@bawes.net",
    "email": "khalid@bawes.net",
    "name": "Khalid Al-Mutawa",
    "groups": ["authentik Admins"],
    "expiresAt": "2025-12-07T19:56:49.000Z",
    "issuedAt": "2025-12-07T19:51:49.000Z"
  }
}
```

### Invalid/Expired Token

```json
{
  "success": false,
  "decoded": { ... },
  "userInfo": null,
  "tokenInfo": { ... }
}
```

## Troubleshooting

### Token Validation Fails

**Possible causes:**

1. **Token Expired**
   - Get a fresh token from Authentik
   - Check expiration time in decoded token

2. **OIDC_ISSUER Mismatch**
   - Ensure `.env` has correct `OIDC_ISSUER`
   - Restart container: `docker-compose up -d --force-recreate admin-api`

3. **OIDC_CLIENT_ID/CLIENT_SECRET Incorrect**
   - Verify values in `.env` match Authentik configuration
   - Restart container after updating

4. **OIDC Provider Not Accessible**
   - Check network connectivity to `https://auth.bawes.net`
   - Verify Authentik is running and accessible
   - Check firewall rules

5. **Token Signature Invalid**
   - Token may be corrupted or tampered with
   - Get a fresh token from Authentik

### Check OIDC Configuration

```bash
# Check environment variables in container
docker exec admin-api-dev sh -c 'env | grep OIDC'

# Test OIDC provider accessibility
curl https://auth.bawes.net/application/o/universe/.well-known/openid-configuration
```

### Verify Authentik Configuration

1. **Check OIDC Provider Settings:**
   - Issuer URL matches: `https://auth.bawes.net/application/o/universe/`
   - Client ID matches your `.env` file
   - Client Secret matches your `.env` file

2. **Check User Claims:**
   - Ensure `email`, `name`, `groups` claims are included
   - Verify scopes: `email openid profile`

3. **Check Token Expiration:**
   - Default is usually 1 hour
   - Can be configured in Authentik provider settings

## Next Steps

1. **Get a fresh token** from Authentik/WorkAdventure
2. **Test the token** using the verification script
3. **Use the token** in API requests with `accessToken` query parameter

Example API call with OIDC token:

```bash
curl -H "Authorization: Bearer {ADMIN_API_TOKEN}" \
  "http://admin.bawes.localhost/api/room/access?userIdentifier=khalid@bawes.net&playUri=http://play.workadventure.localhost/@/default/default/default&accessToken=YOUR_FRESH_TOKEN"
```

