# Orbit Mobile Authentication & Deep-Link Architecture

## Overview

Orbit supports native mobile authentication on iOS and Android via custom URL scheme deep linking (`bawes://callback`). This allows native mobile clients (built with Capacitor) to complete OIDC logins seamlessly without losing state or getting stranded in external browser tabs.

---

## 1. What `bawes://callback` Is and How It Works

### The Mobile Web Redirect Problem
In standard web OIDC authentication:
1. The app directs the user to the OIDC identity provider (Keycloak, Authentik, etc.).
2. The user authenticates with credentials.
3. The provider redirects back to a configured HTTPS URL (e.g. `https://orbit.bawes.net/admin/login`).
4. On a mobile device, this final redirect opens a tab in the system browser (Safari or Chrome), leaving the native app unable to intercept the authorization code or access token.

### The Custom Scheme Solution (`bawes://callback`)
- `bawes://callback` is a custom URL scheme registered with the operating system via the native application manifest/plist.
- When the OIDC provider redirects to `bawes://callback?code=...` or `bawes://callback#access_token=...`:
  - **iOS**: The OS recognizes `bawes://` via `CFBundleURLSchemes` and brings the BAWES native application to the foreground.
  - **Android**: The OS matches an `<intent-filter>` with `android:scheme="bawes"` and delivers the intent to the main activity.
- The system browser tab closes automatically, and the native Capacitor WebView receives the URL via the deep-link listener.

---

## 2. OIDC Provider Configuration

To enable mobile authentication, `bawes://callback` must be registered as a permitted redirect URI in your identity provider.

### Environment Configuration
Ensure your `.env` file defines:
```bash
# Mobile App Deep-Link (register this in your OIDC provider)
MOBILE_REDIRECT_URI=bawes://callback
```

### A. Keycloak Configuration (Step-by-Step)
1. Log into the **Keycloak Admin Console**.
2. Select your realm (e.g., `workadventure`).
3. In the left navigation menu, click **Clients**.
4. Select the client used by Orbit (e.g. `workadventure` or `universe-admin`).
5. In the **Settings** tab, locate **Valid Redirect URIs**.
6. Add the following entry alongside your existing web URIs:
   ```text
   bawes://callback*
   ```
7. (Optional) In **Valid Post Logout Redirect URIs**, add:
   ```text
   bawes://logout*
   ```
8. Click **Save** at the bottom of the page.

### B. Authentik Configuration (Step-by-Step)
1. Log into the **Authentik Admin Interface**.
2. Navigate to **Applications** → **Providers**.
3. Select your OIDC Provider.
4. Under **Redirect URIs/Origins**, add:
   ```text
   ^bawes://callback.*$
   ```
   or the exact literal match:
   ```text
   bawes://callback
   ```
5. Save changes.

---

## 3. Capacitor WebView Implementation

### A. Deep Link Listener (`@capacitor/app`)
In the mobile application code, register a listener for `appUrlOpen`:

```typescript
import { App, URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

// Listen for deep link return from OIDC
App.addListener('appUrlOpen', async (event: URLOpenListenerEvent) => {
  if (event.url.startsWith('bawes://callback')) {
    // Close the in-app authentication browser sheet
    await Browser.close();

    const parsedUrl = new URL(event.url);
    const accessToken = parsedUrl.searchParams.get('accessToken') || 
                        new URLSearchParams(parsedUrl.hash.substring(1)).get('access_token');

    if (accessToken) {
      // Exchange with Orbit backend
      const res = await fetch('https://orbit.bawes.net/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          redirect_uri: 'bawes://callback'
        })
      });

      const session = await res.json();
      if (res.ok && session.sessionId) {
        // Store opaque session in sessionStorage / native storage
        sessionStorage.setItem('orbit_session_v2', session.sessionId);
        window.location.replace('/admin');
      }
    }
  }
});
```

### B. Initiating Mobile Login
When the user taps "Sign In" on mobile:
```typescript
import { Browser } from '@capacitor/browser';

export async function startMobileLogin(oidcAuthorizeUrl: string, clientId: string) {
  const authUrl = new URL(oidcAuthorizeUrl);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', 'bawes://callback');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');

  // Open in an in-app browser sheet
  await Browser.open({
    url: authUrl.toString(),
    windowName: '_self'
  });
}
```

---

## 4. Security & Origin Policy

1. **Capacitor Origins**: The backend login endpoint (`POST /api/auth/login`) accepts standard mobile WebView origins:
   - iOS: `capacitor://localhost`
   - Android: `https://localhost` or `http://localhost`
   - Direct/custom scheme: `bawes://` and `null`
2. **Opaque Sessions**: Login returns an opaque `orb_sess_v2_...` token. Raw OIDC tokens are never stored long-term in the WebView.
3. **PKCE (Proof Key for Code Exchange)**: Native clients should always use PKCE with code flow to ensure authorization code interception cannot be abused.
