# Mobile Authentication & Deep-Link Guide (`bawes://callback`)

This guide explains how Orbit Admin (`workadventure-universe-admin`) and the BAWES Universe Capacitor mobile app (`net.bawes.universe`) handle OIDC authentication and redirect callbacks on Android and iOS.

---

## 1. What `bawes://callback` Is and How It Works

In the browser, Orbit runs embedded inside `universe.bawes.net` and exchanges OIDC access tokens over same-origin or configured web origins (`https://orbit.bawes.net`, `https://universe.bawes.net`).

On Android and iOS, the native Capacitor shell wraps `https://universe.bawes.net` inside a mobile WebView. When a user signs in via an external OIDC provider (Keycloak, Authentik, or a federated identity provider such as Google/Apple SSO), the browser/system authentication session needs a way to hand control back to the native app rather than stranding the user in a mobile browser tab.

A custom URL scheme (`bawes://callback`) solves this:

1. **Login Initiation**: The mobile app or WebView initiates the OIDC authorization code flow (or resolves its callback target via `GET /api/auth/login`) with `redirect_uri=bawes://callback`.
2. **OS Deep-Link Interception**: After the user authenticates with the OIDC provider, the provider redirects to `bawes://callback?code=...&state=...`.
3. **Native Hand-off to Capacitor**: Android (`intent-filter` on scheme `bawes`) and iOS (`CFBundleURLTypes` on scheme `bawes`) intercept the `bawes://callback` URL at the OS level and route it directly into the running `net.bawes.universe` app.
4. **Session Exchange**: The Capacitor WebView receives the callback URL via `@capacitor/app`'s `appUrlOpen` event, completes token exchange, and establishes an Orbit v2 session (`POST /api/auth/login` or `POST /api/auth/session`).

---

## 2. Environment Configuration

Add `MOBILE_REDIRECT_URI` to your `.env` (already documented in `.env.example`):

```env
# Mobile App Deep-Link (register this in your OIDC provider)
MOBILE_REDIRECT_URI=bawes://callback
```

If `MOBILE_REDIRECT_URI` is omitted, Orbit defaults to `bawes://callback`.

### Origin & Redirect Validation in Orbit

- **`app/api/auth/redirect-uri.ts`**:
  - Validates candidate `redirect_uri` parameters against configured web origins (`ADMIN_API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PLAY_URL`, `PLAY_URL`) **and** `MOBILE_REDIRECT_URI` (`bawes://callback`).
  - Automatically resolves `bawes://callback` when `GET /api/auth/login` is called from an Android WebView (`; wv)`), iOS WKWebView, or Capacitor User-Agent.
  - Rejects untrusted third-party redirect URIs and dangerous schemes (`javascript:`, `data:`, `file:`) with `400 Invalid redirect_uri`.
- **`app/api/auth/login/route.ts` & `app/api/auth/session/route.ts`**:
  - Permit requests carrying `Origin: bawes://callback` or `Origin: bawes://` alongside the configured web origins (note that WHATWG `new URL('bawes://callback').origin` evaluates to `"null"`, so custom-scheme origins are validated by protocol and host via `isMobileOrigin`).
- **`middleware.ts`**:
  - Allows `bawes://` origins through without origin blocking and sets `Access-Control-Allow-Origin` and `Vary: Origin` on `/api/auth/*` routes.

---

## 3. Registering `bawes://callback` in Your OIDC Provider

### Option A: Keycloak

1. Open the **Keycloak Admin Console** and select your realm.
2. Navigate to **Clients** → select the Universe / Orbit OIDC client (e.g. `workadventure` or `orbit-admin`).
3. Under the **Settings** tab, find **Valid Redirect URIs**.
4. Add the mobile deep-link URI alongside your existing web callback URLs:
   ```text
   https://universe.bawes.net/*
   https://orbit.bawes.net/*
   bawes://callback
   ```
5. Under **Web Origins**, keep your web origins (`https://universe.bawes.net`, `https://orbit.bawes.net`) or `+` to permit configured redirect origins.
6. Click **Save**.

### Option B: Authentik (Production)

1. Open the **Authentik Admin Interface**.
2. Go to **Applications** → **Providers** and edit your OIDC OAuth2 Provider.
3. Under **Protocol settings** → **Redirect URIs/Origins (RegEx)**:
   - Add a `Strict` match entry for:
     ```text
     bawes://callback
     ```
   - Keep your existing web redirect URIs (`https://universe.bawes.net/.*`, `https://orbit.bawes.net/.*`).
4. Click **Update** to save the provider configuration.

### Option C: Local Development (`oidc-server-mock`)

In `docker-compose.yaml`, ensure `bawes://callback` is included in `CLIENT_REDIRECT_URIS` (or `CLIENTS_CONFIGURATION_INLINE`) for `oidc-server-mock`:

```json
{
  "ClientId": "authorization-code-client-id",
  "ClientSecrets": ["authorization-code-client-secret"],
  "RedirectUris": [
    "http://play.workadventure.localhost/*",
    "http://admin.bawes.localhost/*",
    "bawes://callback"
  ]
}
```

---

## 4. How the Capacitor WebView Handles the Redirect

### Android (`AndroidManifest.xml`)

The main activity registers a custom scheme intent filter for `bawes://callback`:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="bawes" android:host="callback" />
</intent-filter>
```

### iOS (`Info.plist`)

The iOS target registers `bawes` under `CFBundleURLTypes`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>net.bawes.universe</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>bawes</string>
    </array>
  </dict>
</array>
```

### Capacitor App Listener

When the OS hands `bawes://callback?...` to the native shell, Capacitor dispatches the `appUrlOpen` event to the WebView:

```typescript
import { App, URLOpenListenerEvent } from '@capacitor/app';

App.addListener('appUrlOpen', async (event: URLOpenListenerEvent) => {
  const url = new URL(event.url);
  if (url.protocol === 'bawes:' && url.host === 'callback') {
    // Forward OIDC callback parameters or exchange token with Orbit (/api/auth/login)
    const token = url.searchParams.get('accessToken') || url.searchParams.get('code');
    if (token) {
      await fetch('https://orbit.bawes.net/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: token,
          redirect_uri: 'bawes://callback',
        }),
      });
    }
  }
});
```

---

## 5. Testing Manually & with Automated Tests

### Simulate a Mobile WebView Login via `curl`

1. **Resolve redirect URI with an Android WebView or iOS WKWebView User-Agent**:
   ```bash
   curl -i "http://localhost:3333/api/auth/login" \
     -H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36"
   ```
   Expected response (`200 OK`):
   ```json
   {"redirectUri":"bawes://callback","isMobile":true}
   ```

2. **Explicitly validate `redirect_uri=bawes://callback`**:
   ```bash
   curl -i "http://localhost:3333/api/auth/login?redirect_uri=bawes://callback"
   ```
   Expected response (`200 OK`):
   ```json
   {"redirectUri":"bawes://callback","isMobile":true}
   ```

3. **Verify untrusted redirect URIs are rejected**:
   ```bash
   curl -i "http://localhost:3333/api/auth/login?redirect_uri=https://evil.example/callback"
   ```
   Expected response (`400 Bad Request`):
   ```json
   {"error":"Invalid redirect_uri"}
   ```

### Run the Automated Test Suite

```bash
npx jest app/api/auth/mobile-auth.test.ts
```
