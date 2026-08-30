# Secure iframe authentication v2

Orbit accepts WorkAdventure authentication through a versioned `postMessage` handshake. The iframe sends an `orbit-auth-ready-v2` message with a fresh nonce to `NEXT_PUBLIC_PLAY_URL`; WorkAdventure replies to the exact admin origin with an `orbit-auth-token-v2` message containing the same nonce and the OIDC access token.

The admin exchanges that token at `POST /api/auth/login`. The response contains an opaque `orb_sess_v2_…` identifier whose SHA-256 digest is stored in Redis. Browser API requests carry the identifier in the `Authorization` header. Unsigned JSON/base64 tokens, cookies, localStorage credentials, and URL query credentials are not accepted as sessions.

## Coordinated rollout

1. Set `NEXT_PUBLIC_PLAY_URL` to the exact WorkAdventure origin.
2. Temporarily set `NEXT_PUBLIC_ALLOW_LEGACY_IFRAME_BOOTSTRAP=true` and deploy the admin change. This bridge accepts only the existing OIDC bootstrap URL; it never enables legacy unsigned sessions.
3. Deploy the WorkAdventure change that uses the v2 handshake and credential-free iframe URL.
4. Set `NEXT_PUBLIC_ALLOW_LEGACY_IFRAME_BOOTSTRAP=false` and redeploy the admin image.

The application default is `false`. The first coordinated Docker rollout defaults the build argument to `true` so the existing iframe keeps working between deployments; rebuild with `--build-arg NEXT_PUBLIC_ALLOW_LEGACY_IFRAME_BOOTSTRAP=false` after WorkAdventure is updated. Production requires `REDIS_URL`; the process refuses to create sessions without it. Development and tests use an in-memory store when Redis is not configured.
