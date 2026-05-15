# Mobile Authentication Deep Link

The Capacitor mobile app uses the admin API from a WebView. During OIDC login, the identity provider must be able to redirect back to the installed app instead of only returning to an HTTP origin.

## Redirect URI

Register this redirect URI in the OIDC provider:

```text
bawes://callback
```

The admin API accepts this value through `MOBILE_REDIRECT_URI`. If the variable is not set, the default remains `bawes://callback`.

## API behavior

- `GET /api/auth/mobile-redirect` returns the configured mobile redirect URI and the allow-list.
- `POST /api/auth/mobile-redirect` validates a request body containing `redirectUri` or `redirect_uri`.
- `POST /api/auth/login` and `POST /api/auth/session` accept optional `redirectUri` or `redirect_uri` fields and reject unsupported custom schemes.

The existing web login continues to work without sending a redirect URI. Mobile clients should send `bawes://callback` when exchanging an OIDC access token for an admin session so the server can validate the mobile redirect target.

## Capacitor handling

The mobile app should register the `bawes` URL scheme and handle `bawes://callback` with the Capacitor App URL listener. After the provider redirects to the deep link, the app can extract the returned OIDC data, complete the token exchange, and call `/api/auth/session` with the resulting access token.

## Middleware review

`middleware.ts` only runs for HTTP requests handled by Next.js. The custom-scheme callback is opened by the operating system and handled by the mobile app, so the middleware does not block the `bawes://` origin. API routes remain allowed before admin page session checks.
