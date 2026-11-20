# Fake payment service (for the staging checkout journeys)

A small payment service we control, for testing Universe page payments on staging without a real provider. **Test infrastructure only**: it is not part
of the Orbit image (`tools` is in `.dockerignore`), nothing in Orbit refers to it, and no environment variable of the product points at it. No money moves.

It behaves like a hosted-checkout gateway: make a payment link, look a payment up, keys that start with `sk_test_` or `sk_live_` (a key only sees payments
made with a key of its own kind), a hosted page with **Pay** and **Cancel**, and a notice to Orbit when a payment completes.

## Run it

Node 20+, no dependencies. One command:

```
CONTROL_TOKEN=<a long random value, 16+ characters> BASE_URL=https://fake-pay.example.org node server.js
```

or with Docker (build from this folder):

```
docker build -t fake-payment-gateway . && docker run -p 8080:8080 -e CONTROL_TOKEN=... -e BASE_URL=https://fake-pay.example.org fake-payment-gateway
```

| Variable | What |
|---|---|
| `CONTROL_TOKEN` | **Required**, no default. Protects every `/control/*` call (header `x-control-token`, or `Authorization: Bearer`). Without a good one the server does not start. |
| `BASE_URL` | The public address, **https, no port** (Orbit refuses a checkout link that is not https or that has a port). Behind a proxy that sets `X-Forwarded-Proto/Host` it can be left out. |
| `PORT` | Default 8080. |
| `DATA_FILE` | Optional. A file (on a volume) that keeps payments across a restart. |

On Coolify: a new application from this repository with base directory `tools/fake-payment-gateway`, build pack Dockerfile, a domain with https, and the
two variables above. The service must be reachable from Orbit staging, and it sends notices to Orbit staging's public address, so Orbit must be
reachable from it. Check `GET <BASE_URL>/health`.

## Connect it to Orbit staging

`GET <BASE_URL>/definition` is the service's setup as data (what an owner's Brick would write from its docs); `GET <BASE_URL>/docs` is the same as a page a Brick can read. It makes a custom
app called "Fake Pay". Two ways, both the normal product path:

1. In the game, ask the owner's Brick: *"Connect the payment app whose docs are at <BASE_URL>/docs"*, then paste a key into the safe form that opens.
2. Or on the API: `POST /api/bots/<brickId>/app-key-forms` with the service token and `{ requesterKey: <owner>, draft: <the /definition JSON>, source: "<BASE_URL>/docs" }`,
   then type the key into the form (`POST /api/me/apps/key-forms/<id>/key`).

Use `sk_test_` plus at least 8 more characters for test mode, `sk_live_...` for the live kind (both are made up: any such key is accepted; anything else is a 401).
Then have the Brick set up a payment job for a page as usual.

## What the Dev desk can do (control API)

All calls need `-H "x-control-token: $T"`. `$B` is the base address.

| To test | Do |
|---|---|
| **Pay / cancel** (signed in and guest) | Open the checkout link and press Pay or Cancel (or `POST /control/payments/<id>` `{"action":"capture"}` / `{"action":"cancel"}`). |
| **Reload while paying** | Press nothing; reload the page; the order stays the same. |
| **20-minute walk-away, then a late payment** | `POST /control/next {"lateMinutes": 1500}` before the checkout: the payment completes 25 hours after it was made, once the buyer pressed Pay. Or on one payment: `{"action":"late","minutes":1500}`. Or put `[fake late=1500]` in the page's description. |
| **Duplicate notice** | `POST /control/next {"duplicateNotice": 2}`, or `{"action":"notify","times":2}` on a payment, or `[fake dup]` in the description. |
| **Service unreadable** | `POST /control/unreadable {"mode":"5xx","seconds":600}`; modes `5xx`, `timeout`, `drop`, `401`, `garbage`, `empty`; `{"off":true}` ends it. |
| **Payment made, answer lost** | `POST /control/create-fault {"mode":"timeout","times":1,"made":true}`: the payment IS made and only the answer is lost. Without `made` nothing is made. |
| **Wrong amount / currency / mode / order** | `POST /control/next {"mismatch":{"amount":1}}` (or `currency`, `live`, `order`): the record says so once the payment is captured. In the description: `[fake amount=1]`, `[fake currency=USD]`, `[fake live]`, `[fake order]`. |
| **Test vs live** | Connect with `sk_test_...` and again (another owner) with `sk_live_...`; each key only sees its own kind. |
| **Look at it** | `GET /control/state`, `/control/payments` (status, scenario, notices owed and sent), `/control/notices` (what Orbit answered to each notice). |
| **Start clean** | `POST /control/reset`. `POST /control/next {"clear":true}` clears the next-payment settings. |

Timing: the server completes late payments and sends owed notices every second. The late time counts from when the payment was made, and a late payment
completes only after the buyer pressed Pay on the hosted page.

## Tests

- On its own: `node --test selftest/gateway.check.js`.
- Against Orbit (a real database, the fake answering every request Orbit makes and sending its own notices to Orbit's notice route):
  `ROLES_DB_TEST=yes DATABASE_URL=... npx jest --runInBand __tests__/api/fake-gateway-journeys-db.test.ts` from the Orbit repository.

## What it does not do

It is not a real provider: no 3-D Secure, no refunds, no webhooks with signatures (Orbit does not trust a notice anyway; it only makes Orbit ask the service
itself). A real browser, a real provider and real money are for the release checks.
