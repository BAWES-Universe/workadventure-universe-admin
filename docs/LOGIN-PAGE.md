# Login Page Configuration

## Overview

Orbit runs only inside Universe. The game opens `/admin/login` in an iframe and
hands Orbit a session through a `postMessage` handshake (`orbit-auth-ready-v2` /
`orbit-auth-token-v2`). Orbit keeps its session token in the iframe's
`sessionStorage` and sends it as an `Authorization` header (no cookies).

- **Opened directly** (not in an iframe), or the game does not answer the
  handshake within 10 seconds: the page shows one line, "Orbit runs inside
  Universe", with a link to `NEXT_PUBLIC_PLAY_URL`. Nothing is fetched and no
  stored session is reused.
- **Every open performs the handshake.** A session already stored in the tab is
  never reused on its own: the game may now be signed in as someone else. The
  handshake's token is exchanged for a fresh session, the old one is revoked, and
  unless the stored session is known to belong to the same Universe user, every
  per-account cache in the tab is cleared (`lib/client-auth.ts`
  `adoptHandshakeSession`).

## Environment Variables

### `NEXT_PUBLIC_ENABLE_MANUAL_LOGIN`

- **Type**: `boolean` (string: `"true"` or `"false"`)
- **Default**: `false` (not set)
- **Purpose**: Enables the manual token input form for developers testing without the WorkAdventure iframe experience

#### Usage

To enable manual login for development/testing:

```bash
# In .env.local or docker-compose.yml
NEXT_PUBLIC_ENABLE_MANUAL_LOGIN=true
```

#### Behavior

- **When `false` (default)**: 
  - Shows a loading spinner with "Loading universe..." message
  - Waits for the game's `orbit-auth-token-v2` handshake message
  - No manual input form is shown
  - This is the production/iframe experience

- **When `true`**:
  - Shows loading spinner initially
  - After 2 seconds, shows manual token input form if no token received
  - Users can manually enter an OIDC access token
  - Useful for developers testing without WorkAdventure

## Authentication Flow

1. **Universe (default)**: the game's Orbit button opens `/admin/login?playUri=…`
   in an iframe; the page posts `orbit-auth-ready-v2` with a nonce to the play
   origin; the game answers with `orbit-auth-token-v2` carrying its OIDC access
   token; Orbit exchanges it at `POST /api/auth/login`, confirms the user with
   `GET /api/auth/me`, stores the session and redirects into Orbit.
2. **Manual Login (Development Only)**: only when
   `NEXT_PUBLIC_ENABLE_MANUAL_LOGIN=true` outside production; paste an OIDC access
   token into the form.

## Getting an OIDC Token for Testing

If you need to test manually:

1. Log into WorkAdventure at `http://play.workadventure.localhost`
2. Open browser DevTools → Network tab
3. Look for API calls with `accessToken` parameter
4. Copy the token value
5. Use it in the manual login form (if enabled)

## Security Notes

- Manual login should **only** be enabled in development environments
- In production, rely on WorkAdventure's OIDC flow
- Never commit `.env.local` files with `NEXT_PUBLIC_ENABLE_MANUAL_LOGIN=true` to version control

