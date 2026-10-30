# Personal voice keys API (#749, part of #740)

A person can add their own voice key and lend it to a universe where they have Manage bots, so a bot they made there can
listen or speak on their key instead of Universe AI's. The key's owner pays; nobody else's allowance is touched. A key is a
`voice_providers` row with an `owner_id`: the rows with none are the server's own providers
([VOICE_PROVIDERS_API.md](VOICE_PROVIDERS_API.md)), which the routes below never touch, and those routes never list a person's key.

This first part is the key and the lend. Publishing a bot's voice with a lent key, and a key that stops working, come next.
Nothing in Orbit calls a provider: no key is tested here and the models a key lists are the ones its owner names.

A key: `{ id, adapter, company, name, recognition, speech, last4, models, lentTo, createdAt }`. `models` is
`[{ id, label?, kind: "recognition" | "speech" }]`, each kind one the key does. `lentTo` is
`[{ universeId, universeName, ownedByYou, models }]` where `models` is the lend's allowed models as `"kind:id"`, or `null` for
all of them. The key is encrypted with `ENCRYPTION_KEY`, never sent to a browser, and only its last four characters are shown.
A key someone owns is on from the start, is never a default, and is deleted with its owner.

## The caller's own keys (session)

| Route | What it does |
| --- | --- |
| `GET /api/me/voice-keys` | `{ keys, companies }`: the caller's keys, and the speech companies a key can be added for (`[{ adapter, label }]`) |
| `POST /api/me/voice-keys` | `{ adapter, name?, recognition?, speech?, apiKey, models? }`. The key listens, speaks or both. 201 with `{ key }` |
| `PATCH /api/me/voice-keys/:id` | Changes only what is named: `name`, `apiKey` (replaces the saved one), `models`. A model taken off the key is taken off every lend that named it; a lend left with none goes back to all of the key's |
| `DELETE /api/me/voice-keys/:id` | Takes the key away with every lend of it |
| `POST /api/me/voice-keys/:id/lend` | `{ universeId, models? }`. Needs the universe's owner, or Manage bots in it (the universes come from `GET /api/me/ai-keys/universes`). `models`: `null` = all of the key's, a list of `"kind:id"` = only these (each on the key's list), left out = as it is (all, for a new lend). Lending again is fine |
| `DELETE /api/me/voice-keys/:id/lend/:universeId` | Pulls the key from a universe. Always the key owner's to do |

Someone else's key, and a server provider, are 404. Lending moves no bot.
