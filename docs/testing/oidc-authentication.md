# Testing OIDC Authentication

Guide for testing the OIDC-based admin interface.

## Quick Start

### 1. Start Services

```bash
# Terminal 1: Start WorkAdventure (includes OIDC mock)
cd workadventure
docker-compose up

# Terminal 2: Start Admin API
cd workadventure-universe-admin
npm run dev
```

### 2. Get OIDC Access Token

#### Method 1: From WorkAdventure Browser Session

1. Open `http://play.workadventure.localhost` in your browser
2. Log in with OIDC mock credentials:
   - Username: `User1`
   - Password: `pwd`
3. Open DevTools (F12) → Network tab
4. Filter by "Fetch/XHR"
5. Look for requests to your admin API (e.g., `/api/map`, `/api/room/access`)
6. Click on a request → Headers or Payload
7. Find `accessToken` in:
   - Query parameters: `?accessToken=...`
   - Or in request headers
8. Copy the token value

#### Method 2: Direct OIDC Mock Request

You can also get a token directly from the OIDC mock:

```bash
# Get authorization code (requires browser interaction)
# Or use a tool like Postman to complete OIDC flow

# The OIDC mock is at:
http://oidc.workadventure.localhost
```

#### Method 3: Test Token Helper

Visit:
```
http://localhost:3000/api/test/get-token
```

This shows instructions and available test users.

### 3. Login to Admin Interface

1. Go to `http://localhost:3000/admin/login`
2. Paste the access token you obtained
3. Click "Sign in"
4. You'll be redirected to `/admin` dashboard

### 4. Test User Management

Once logged in, you can:

- **View your universes**: `/admin/universes` (shows only yours)
- **Create universes**: Click "Create Universe" (you'll be the owner)
- **Manage worlds**: `/admin/worlds` (worlds in your universes)
- **Manage rooms**: `/admin/rooms` (rooms in your worlds)

## Test Users (OIDC Mock)

The OIDC mock comes with these test users:

| Username | Password | Email | Tags |
|----------|----------|-------|------|
| User1 | pwd | john.doe@example.com | ["admin"] |
| User2 | pwd | alice.doe@example.com | ["member"] |
| UserMatrix | pwd | john.doe@example.com | ["admin"] |

## Testing Scenarios

### Scenario 1: Create Your First Universe

1. **Login as User1**:
   - Get token from WorkAdventure
   - Login at `/admin/login`

2. **Create Universe**:
   - Go to `/admin/universes`
   - Click "Create Universe"
   - Fill in:
     - Slug: `my-company`
     - Name: `My Company`
     - Description: `Test universe`
     - Owner: Should be pre-selected (you)
   - Click "Create"

3. **Verify**:
   - Universe appears in your list
   - You can see it's owned by you

### Scenario 2: Multiple Users

1. **User1 creates universe**:
   - Login as User1
   - Create universe "Company A"

2. **User2 creates universe**:
   - Logout
   - Login as User2
   - Create universe "Company B"

3. **Verify isolation**:
   - User1 only sees "Company A"
   - User2 only sees "Company B"

### Scenario 3: API vs Web Interface

**API with Admin Token** (sees all):
```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  http://localhost:3000/api/admin/universes
```

**Web Interface with OIDC** (sees only yours):
- Login via OIDC
- Visit `/admin/universes`
- Only your universes are shown

## Troubleshooting

### "Invalid access token"

**Problem**: Token validation fails

**Solutions**:
- Check that OIDC_ISSUER is set correctly in `.env.local`
- Verify OIDC mock is running: `curl http://oidc.workadventure.localhost/.well-known/openid-configuration`
- Ensure token hasn't expired (OIDC mock tokens may expire)
- Get a fresh token from WorkAdventure

### "Not authenticated"

**Problem**: Session cookie missing or invalid

**Solutions**:
- Clear cookies and login again
- Check that cookies are enabled in browser
- Verify session cookie is being set (check DevTools → Application → Cookies)

### Can't see my universes

**Problem**: Seeing all universes instead of just yours

**Solutions**:
- Verify you're logged in (check top-right corner shows your name)
- Check that the API is filtering by `ownerId`
- Try logging out and back in

### OIDC mock not accessible

**Problem**: `http://oidc.workadventure.localhost` not resolving

**Solutions**:
- Ensure WorkAdventure docker-compose is running
- Check Traefik routing: `curl -H "Host: oidc.workadventure.localhost" http://localhost/.well-known/openid-configuration`
- Verify `/etc/hosts` or DNS has `oidc.workadventure.localhost` pointing to localhost

## Environment Variables

Ensure these are set in `.env.local`:

```env
# OIDC Configuration
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret

# Admin API Token (for API calls)
ADMIN_API_TOKEN=your-secret-token-here
```

## Next Steps

- Implement proper OIDC authorization code flow (instead of manual token entry)
- Add token refresh functionality
- Implement role-based access control (RBAC)
- Add user profile management
- Add universe/world/room sharing and permissions
- See [Integration Tests](./integration-tests.md) for automated OIDC testing

