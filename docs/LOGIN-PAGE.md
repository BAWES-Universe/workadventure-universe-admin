# Login Page Configuration

## Overview

The login page is designed to work seamlessly with WorkAdventure iframe integration. By default, it shows a loading state while waiting for WorkAdventure to provide an OIDC access token via URL parameter.

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
  - Waits for `accessToken` URL parameter from WorkAdventure
  - No manual input form is shown
  - This is the production/iframe experience

- **When `true`**:
  - Shows loading spinner initially
  - After 2 seconds, shows manual token input form if no token received
  - Users can manually enter an OIDC access token
  - Useful for developers testing without WorkAdventure

## Authentication Flow

1. **WorkAdventure Integration (Default)**:
   - User logs into WorkAdventure
   - WorkAdventure redirects to `/admin/login?accessToken=...`
   - Login page automatically processes the token
   - User is redirected to the admin dashboard

2. **Manual Login (Development Only)**:
   - Only available when `NEXT_PUBLIC_ENABLE_MANUAL_LOGIN=true`
   - User can click "Use manual login instead" or wait 2 seconds
   - User enters OIDC access token manually
   - Token is validated and user is logged in

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

