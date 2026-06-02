# Mobile Auth Deep Link

The BAWES Universe mobile app uses Capacitor to wrap `universe.bawes.net`.
When mobile login leaves the WebView for the OIDC provider, the provider must
return to the native app through a custom URL scheme:

```text
bawes://callback
```

Set this value in `.env`:

```bash
MOBILE_REDIRECT_URI=bawes://callback
```

The auth API accepts this mobile redirect URI alongside the normal web login
callback at `/admin/login`. Query parameters appended by the OIDC provider,
such as `code` and `state`, are allowed as part of the callback delivery.

## OIDC Provider Registration

Register the mobile redirect URI in the same OIDC client used by WorkAdventure
and Orbit admin:

```text
bawes://callback
```

For Keycloak:

1. Open the realm used by BAWES Universe.
2. Go to Clients and select the WorkAdventure/OIDC client.
3. Add `bawes://callback` to Valid redirect URIs.
4. Keep the existing web redirect URI for `/admin/login`.
5. Save the client and run one login from Android or iOS.

For Authentik:

1. Open the OAuth2/OpenID provider used by WorkAdventure.
2. Add `bawes://callback` to Redirect URIs / Origins.
3. Keep the existing web callback URL.
4. Save the provider and refresh the application binding if needed.

For the WorkAdventure OIDC mock, add the URI to the mock client redirect list
used by `authorization-code-client-id`.

## Capacitor Flow

1. The native shell loads `https://universe.bawes.net`.
2. Login starts the existing OIDC flow.
3. The provider redirects to `bawes://callback?code=...&state=...`.
4. Android or iOS opens the Capacitor app for the `bawes` scheme.
5. The app forwards the callback data back into the WebView/session exchange.

The Next.js middleware only processes HTTP and HTTPS requests that reach the
admin app. It does not receive `bawes://` callbacks, so no middleware origin
check blocks the custom scheme.
