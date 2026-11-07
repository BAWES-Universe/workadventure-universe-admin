# Mobile Authentication & Deep-Link Guide (`bawes://callback`)

This guide explains how Orbit Admin (`workadventure-universe-admin`) supports mobile OIDC login for the BAWES Universe native Android and iOS apps (`net.bawes.universe`).

## Table of Contents

- [What `bawes://callback` Is and How It Works](#what-bawescallback-is-and-how-it-works)
- [Environment Configuration](#environment-configuration)
- [Registering `bawes://callback` in Your OIDC Provider](#registering-bawescallback-in-your-oidc-provider)
  - [Keycloak (Step-by-Step)](#keycloak-step-by-step)
  - [Authentik (Step-by-Step)](#authentik-step-by-step)
  - [Development OIDC Mock Server](#development-oidc-mock-server)
- [How Capacitor WebView Handles the Redirect](#how-capacitor-webview-handles-the-redirect)
  - [Android Configuration (`AndroidManifest.xml`)](#android-configuration-androidmanifestxml)
  - [iOS Configuration (`Info.plist`)](#ios-configuration-infoplist)
  - [Capacitor App Listener & Session Exchange](#capacitor-app-listener--session-exchange)
- [Manual Testing (Simulating a WebView Login)](#manual-testing-simulating-a-webview-login)

---

## What `bawes://callback` Is and How It Works

When a user signs into BAWES Universe from the native Capacitor mobile app (which wraps `https://universe.bawes.net` inside a mobile WebView), the OpenID Connect (OIDC) authorization flow must return control to the native application after the identity provider completes authentication.

On Android and iOS, a standard `https://` redirect URI can open a separate system browser tab instead of returning to the embedded app session. By registering the custom URL scheme `bawes://callback`:

1. The Capacitor app initiates the OIDC login with `redirect_uri=bawes://callback`.
2. After the user authenticates with the OIDC provider, the provider redirects to `bawes://callback?code=<auth_code>&state=<state>`.
3. Android (via Intent Filters) and iOS (via `CFBundleURLTypes`) intercept the `bawes://` scheme at the OS level and route the callback URI directly into the running `net.bawes.universe` app.
4. Orbit's authentication endpoints (`/api/auth/login` and `/api/auth/session`) and `middleware.ts` explicitly allow `bawes://callback` as a valid OIDC `redirect_uri` alongside existing web URIs and permit Capacitor WebView origins (`bawes://callback`, `capacitor://localhost`, `ionic://localhost`, `http://localhost`, `https://localhost`).

---

## Environment Configuration

Add `MOBILE_REDIRECT_URI` to your `.env` / `.env.local` file (see `.env.example`):

```env
# Mobile App Deep-Link (register this in your OIDC provider)
MOBILE_REDIRECT_URI=bawes://callback
```

If `MOBILE_REDIRECT_URI` is not set, Orbit defaults to `bawes://callback`.

---

## Registering `bawes://callback` in Your OIDC Provider

Your OIDC identity provider must explicitly allow `bawes://callback` in its client redirect URI whitelist.

### Keycloak (Step-by-Step)

1. Sign in to the **Keycloak Admin Console** and select your realm.
2. Navigate to **Clients** in the left sidebar and select the WorkAdventure / Orbit OIDC client (e.g. `authorization-code-client-id` or your production client ID).
3. Under the **Settings** tab, locate **Access settings**:
   - In **Valid redirect URIs**, add:
     ```text
     bawes://callback
     bawes://callback*
     ```
     (Keep all existing web redirect URIs such as `https://universe.bawes.net/*` and `https://orbit.bawes.net/*`.)
   - In **Valid post logout redirect URIs**, optionally add `bawes://callback`.
   - In **Web origins**, add:
     ```text
     +
     capacitor://localhost
     http://localhost
     https://localhost
     ```
4. Click **Save** at the bottom of the page.

### Authentik (Step-by-Step)

1. Open the **Authentik Admin Interface**.
2. Go to **Applications** → **Providers** and select the OAuth2/OpenID Provider used by BAWES Universe / Orbit.
3. Click **Edit** and expand **Protocol settings**.
4. In **Redirect URIs/Origins (RegEx)**, append the mobile deep-link pattern on a new line alongside your existing web URIs:
   ```regex
   ^bawes:\/\/callback(\?.*)?$
   ```
   (In Authentik 2024+, if using `Strict` / `Regex` matching mode, you can add `bawes://callback` as a `Strict` entry or `^bawes://callback(\?.*)?$` as a `Regex` entry.)
5. Click **Update** to save the provider configuration.

### Development OIDC Mock Server

In local Docker Compose development (`OIDC_ISSUER=http://oidc.workadventure.localhost`), `oidc-server-mock` accepts any syntactically valid `redirect_uri` for `authorization-code-client-id` out of the box, or you can include `bawes://callback` in its client `RedirectUris` array if strict redirect checking is enabled.

---

## How Capacitor WebView Handles the Redirect

### Android Configuration (`AndroidManifest.xml`)

In `mobile/android/app/src/main/AndroidManifest.xml` (configured in `workadventure-universe#4`), the main activity registers an intent filter for the `bawes://callback` URI:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="bawes" android:host="callback" />
</intent-filter>
```

### iOS Configuration (`Info.plist`)

In `mobile/ios/App/App/Info.plist` (configured in `workadventure-universe#5`), the app registers the `bawes` URL scheme:

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

### Capacitor App Listener & Session Exchange

1. When the OS opens `bawes://callback?code=...&state=...`, Capacitor dispatches an `appUrlOpen` event inside the native container.
2. Alternatively, if the OIDC callback hits Orbit's `GET /api/auth/login?redirect_uri=bawes://callback&code=...&state=...`, Orbit validates the redirect URI and responds with `302 Found` pointing to `bawes://callback?code=...&state=...` so the native WebView intercepts the custom scheme.
3. Once the mobile client exchanges the authorization code for an OIDC access token, it calls `POST /api/auth/login` or `POST /api/auth/session` with `Origin: capacitor://localhost` (iOS), `Origin: http://localhost` (Android), or `Origin: bawes://callback` to receive an opaque v2 Orbit session (`{ version: 2, sessionId, expiresAt }`).

---

## Manual Testing (Simulating a WebView Login)

You can verify mobile deep-link discovery, callback routing, and origin handling locally using `curl`:

### 1. Simulate WebView User-Agent Discovery (`GET /api/auth/login`)

```bash
curl -i "http://localhost:3333/api/auth/login" \
  -H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36"
```

Expected `200 OK` JSON response:
```json
{
  "redirectUri": "bawes://callback",
  "allowedRedirectUris": [
    "bawes://callback",
    "http://admin.bawes.localhost",
    "http://admin.bawes.localhost/admin",
    "http://admin.bawes.localhost/admin/login",
    "http://admin.bawes.localhost/api/auth/login",
    "http://admin.bawes.localhost/api/oauth/mcp-callback"
  ]
}
```

### 2. Simulate Mobile Callback Redirect (`GET /api/auth/login?redirect_uri=bawes://callback&code=...`)

```bash
curl -i "http://localhost:3333/api/auth/login?redirect_uri=bawes%3A%2F%2Fcallback&code=test_auth_code&state=state_123" \
  -H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36"
```

Expected `302 Found` response:
```http
HTTP/1.1 302 Found
location: bawes://callback?code=test_auth_code&state=state_123
cache-control: no-store
```

### 3. Verify Capacitor Origin Acceptance (`OPTIONS /api/auth/session`)

```bash
curl -i -X OPTIONS "http://localhost:3333/api/auth/session" \
  -H "Origin: capacitor://localhost"
```

Expected `204 No Content` response with `Access-Control-Allow-Origin: capacitor://localhost`.
