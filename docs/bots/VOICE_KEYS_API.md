# Personal voice keys API (#749, part of #740)

A person can add their own voice key and lend it to a universe where they have Manage bots, so a bot they made there can
listen or speak on their key instead of Universe AI's. The key's owner pays; nobody else's allowance is touched. A key is a
`voice_providers` row with an `owner_id`: the rows with none are the server's own providers
([VOICE_PROVIDERS_API.md](VOICE_PROVIDERS_API.md)), which the routes below never touch, and those routes never list a person's key.

Publishing a bot's voice with a lent key is in `VOICE_BOT_API.md`. A key the provider turns away is Down (below).
Nothing in Orbit calls a provider: no key is tested here and the models a key lists are the ones its owner names.

A key: `{ id, adapter, company, name, recognition, speech, last4, models, lentTo, createdAt }`. `models` is
`[{ id, label?, kind: "recognition" | "speech" }]`, each kind one the key does. `lentTo` is
`[{ universeId, universeName, ownedByYou, models }]` where `models` is the lend's allowed models as `"kind:id"`, or `null` for
all of them. The key is encrypted with `ENCRYPTION_KEY`, never sent to a browser, and only its last four characters are shown.
`health` is `{ status: "working" | "down", downSince, downReason }`, with `downReason` one of `credit`, `rejected`, `model`, `errors` (the same reasons as a text key). A key someone owns is on from the start, is never a default, and is deleted with its owner.

## The caller's own keys (session)

| Route | What it does |
| --- | --- |
| `GET /api/me/voice-keys` | `{ keys, companies }`: the caller's keys, and the speech companies a key can be added for (`[{ adapter, label, recognition, speech }]`): the adapters of the server's own voice providers that are on, so a super admin decides what Universe supports |
| `POST /api/me/voice-keys` | `{ adapter, name?, recognition?, speech?, apiKey, models? }`. `adapter` is one of `companies`, and the key can only do what that company does. The key listens, speaks or both. 201 with `{ key }` |
| `PATCH /api/me/voice-keys/:id` | Changes only what is named: `name`, `apiKey` (replaces the saved one), `models`. A model taken off the key is taken off every lend that named it; a lend left with none is pulled from that universe, as if the key were pulled (its bots there carry on in text) |
| `POST /api/me/voice-keys/:id/check` | "Check now" on a Down key: the next bot that needs it is let through to try, without waiting out the 5 minutes. Calls no provider. 200 with `{ key }`; a key that is not Down is left as it is |
| `DELETE /api/me/voice-keys/:id` | Takes the key away with every lend of it |
| `POST /api/me/voice-keys/:id/lend` | `{ universeId, models? }`. Needs the universe's owner, or Manage bots in it (the universes come from `GET /api/me/ai-keys/universes`). `models`: `null` = all of the key's, a list of `"kind:id"` = only these (each on the key's list), left out = as it is (all, for a new lend). Lending again is fine |
| `DELETE /api/me/voice-keys/:id/lend/:universeId` | Pulls the key from a universe. Always the key owner's to do |

Someone else's key, and a server provider, are 404. Lending moves no bot. A new `apiKey` on a Down key starts it clean: it is tried at once.

## When a key stops working

Orbit calls no provider, so the bot server tells it how each call went (service token): `POST /api/voice/providers/:id/health`
`{ part, ok: true }` or `{ part, ok: false, status?, rejected? }` (`part` is `recognition` or `speech`, the job the call was for) (`VOICE_PROVIDERS_API.md`). The rules are a text key's
(`lib/ai-key-health.ts`): a `401`, `403` or `rejected` is Down (`rejected`), a `402` is Down (`credit`), a `404` is Down (`model`),
two other failures in a row of the same job (a timeout, a `5xx`, a `429`) are Down (`errors`), a request the provider found wrong
(other `4xx`) is not counted, and a call that works marks the key Working again. Each job is counted on its own, so listening
that works does not hide speaking that keeps failing; a key that went Down on one job is Working again when that job works. The bot server sends `status` only for what the provider
said about the key, not for a voice or setting that bot's profile named wrongly.

While a key in a bot's profile is Down, `GET /api/bots/:id/voice/active` says `speaks: false, reason: "key-down"` with
`down: { since, reason }`, and the bot replies in text. Nothing switches to Universe AI's voice by itself; the bot stays in text
until the key's owner moves it in the profile or the key answers again. A Down key is tried again at most every 5 minutes, and
only when a bot needs it: the `active` read that is allowed the try says `speaks: true`, and the call's result decides.
