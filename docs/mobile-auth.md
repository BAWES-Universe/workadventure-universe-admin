# Mobile Deep-Link OIDC Authentication (`bawes://callback`)

This document describes how `workadventure-universe-admin` handles OAuth2 / OIDC redirect URIs and origin validation for the BAWES Universe mobile app (Capacitor / iOS `WKWebView` / Android `WebView`).

## Overview

`workadventure-universe-admin` does not host a browser OAuth2 authorization-code callback route for admin sign-in (the only server-side `redirect_uri` in this repository is for MCP OAuth at `/api/oauth/mcp-callback`). Instead:

1. In web deployments, Orbit runs embedded inside the Universe origin (`NEXT_PUBLIC_PLAY_URL`, e.g. `https://universe.bawes.net`) and exchanges the user's OIDC `accessToken` for an opaque `orb_sess_v2_*` session at `POST /api/auth/login` (from `/admin/login`) or `POST /api/auth/session`.
2. In mobile Capacitor builds, the OIDC login flow completes in the system browser (`SFSafariViewController` on iOS or Chrome Custom Tabs on Android) and returns control to the native app via the custom URL scheme `bawes://callback` (configured via `MOBILE_REDIRECT_URI`).

Standard web origin checks (`new URL(origin).origin`) serialize custom schemes such as `bawes://callback` to `'null'`, and Android Capacitor WebViews default to `https://localhost`. The mobile auth helper (`app/api/auth/redirect-uri.ts`) adds explicit validation for `bawes://callback` and Capacitor container origins while preserving strict origin and open-redirect protections for web clients.

## Environment Configuration

Configure the mobile callback URI in `.env` (defaults to `bawes://callback` when unset):

```dotenv
# Mobile App Deep-Link (register this in your OIDC provider)
MOBILE_REDIRECT_URI=bawes://callback
```

Only valid custom-scheme mobile URIs (without credentials, port numbers, or `..` path traversal segments) are accepted. If `MOBILE_REDIRECT_URI` is set to an unsafe scheme (`javascript:`, `data:`, `http:`, `https:`, `file:`), the server falls back to `bawes://callback`.

To explicitly allow additional mobile container origins without relying on WebView `User-Agent` detection, set `MOBILE_ALLOWED_ORIGINS` (comma-separated, e.g. `MOBILE_ALLOWED_ORIGINS=https://localhost`).

## OIDC Provider Registration (Keycloak)

Register `bawes://callback` in your OIDC provider (such as Keycloak) alongside existing Universe web redirect URIs:

1. Open the **Keycloak Admin Console** and select the target realm.
2. Navigate to **Clients** and select the Universe / Orbit OIDC client (`OIDC_CLIENT_ID`).
3. Under **Settings -> Access settings**, add `bawes://callback` to **Valid Redirect URIs**.
4. Under **Web Origins**, keep the configured Universe web origins (`https://universe.bawes.net`, `https://orbit.bawes.net`); native custom schemes (`bawes://`) and mobile WebView origins are validated by `app/api/auth/redirect-uri.ts`.
5. Save the client configuration.

## Capacitor WebView Redirect & Origin Handling

1. **Native Deep-Link Listener:**
   - Register the `bawes` URL scheme in `Info.plist` (`CFBundleURLSchemes` on iOS) and `AndroidManifest.xml` (`<data android:scheme="bawes" android:host="callback" />` on Android).
   - Listen for incoming callbacks with `@capacitor/app`:
     ```ts
     App.addListener('appUrlOpen', ({ url }) => {
       if (url.startsWith('bawes://callback')) {
         // 1. Exchange the OIDC authorization code with Keycloak token endpoint for an accessToken
         // 2. Send { accessToken, redirectUri: 'bawes://callback' } to POST /api/auth/login or /api/auth/session
       }
     });
     ```
2. **Redirect URI Resolution & Validation (`resolveOidcRedirectUri` & `POST /api/auth/login`):**
   - `resolveOidcRedirectUri()` accepts an explicit `requestedRedirectUri` or inspects `User-Agent` for Capacitor / mobile WebView signatures (`Capacitor`, `bawes-mobile`, Android `; wv)`, or iOS `WKWebView`), resolving `bawes://callback` for mobile WebViews or `${origin}/admin/login` for web clients.
   - `POST /api/auth/login` validates an optional `redirectUri` / `redirect_uri` field in the JSON body against `isValidRedirectUri()` and echoes the validated `redirectUri` alongside the `orb_sess_v2_*` session payload.
3. **Mobile Container Origins (`POST /api/auth/login`, `POST /api/auth/session`, `middleware.ts`):**
   - Permits `bawes://callback`, `bawes://`, `capacitor://localhost` (iOS Capacitor), `ionic://localhost`, and `https://localhost` when accompanied by a mobile WebView `User-Agent` (or `MOBILE_ALLOWED_ORIGINS`) on `/api/auth/login` and `/api/auth/session`.
   - **Security Note on Shared Capacitor Origins:** `capacitor://localhost` and Android `https://localhost` are shared scheme origins across Capacitor apps on a device. Allowing these origins on `/api/auth/login` and `/api/auth/session` does not weaken session security because Orbit v2 sessions are header-only (`Authorization: Bearer orb_sess_v2_*`), `Access-Control-Allow-Credentials` is never set, and every login/session exchange requires a valid OIDC `accessToken` verified against `OIDC_ISSUER`.
