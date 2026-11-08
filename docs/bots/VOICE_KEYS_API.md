# Personal voice keys API (#749, part of #740)

A person can add their own voice key and lend it to a universe where they have Manage bots, so a bot they made there can
listen or speak on their key instead of Universe AI's. The key's owner pays; nobody else's allowance is touched. A key is a
`voice_providers` row with an `owner_id`: the rows with none are the server's own providers
([VOICE_PROVIDERS_API.md](VOICE_PROVIDERS_API.md)), which the routes below never touch, and those routes never list a person's key.

Publishing a bot's voice with a lent key is in `VOICE_BOT_API.md`. A key the provider turns away is Down (below).
Orbit calls a company only for free reads, never a transcription or a spoken reply: it checks a pasted key before it is added ("Load models",
below), and for a key lent to a universe it lists that key's voices and fetches a voice's sample when a maker previews one
(`VOICE_BOT_API.md`). "Load models" fills the list with the ids the server's own providers for that company list, or the catalog's starting models when it has none; saving a key checks only
the shape of each model and that its kind is something the key does, not that the id is one of the server's.

Limits (#783): a key's owner can set four limits for bots that use the key, the ones that are about how much of the key a bot may use:
`turnSeconds` (longest spoken turn), `replyCharacters` and `replySeconds` (longest spoken reply) and `listenMinutesPerDay` (minutes a day one bot
listens). Each is a whole number inside the range the server's voice limits have (`lib/voice-limit-values.ts`, `VOICE_RANGES`).
`PATCH` takes `{ limits: { <name>: value } }`, only the names it sends change, and any other name is a 400. Only the values the owner
changed are saved (`voice_providers.voice_limits`): a value picked that equals the server's own voice limit is dropped, so it follows the
server from then on. The key lists `limits: { <name>: { value, recommended, changed } }` for all four: `recommended` is the server's
current voice limit (never a number kept here), `value` is what applies and `changed` is whether the owner's differs from it.
The bot server reads them in `GET /api/bots/:id/voice/active` (`VOICE_BOT_API.md`).

A key: `{ id, adapter, company, name, recognition, speech, last4, address, models, lentTo, limits, month, createdAt, health }`. `address`
is the host of an own speech server's address (`null` for a company's key). `models` is `[{ id, label?, kind: "recognition" | "speech" | "talk" }]`,
each kind one the key does; a `talk` model listens and speaks in one (a company that talks live), so a bot names it for both. `lentTo` is
`[{ universeId, universeName, ownedByYou, models, bots }]` where `models` is the lend's allowed models as `"kind:id"`, or `null` for
all of them, and `bots` is `[{ id, name, model, voiceReplies }]`: the bots in that universe whose published voice (the revision in
`bots.voice_revision`) names this key for listening or speaking, with the model they use on it (the speaking model if the key speaks for
the bot, else the listening one, as the key labels it) and their voice replies this month. `month` is `{ voiceReplies }`: voice replies
the key paid for this month, counted from the first of the month, UTC, as a text key's usage is. The key is encrypted with `ENCRYPTION_KEY`, never sent to a browser, and only its last four characters are shown.
`health` is `{ status: "working" | "down", downSince, downReason }`, with `downReason` one of `credit`, `rejected`, `model`, `errors` (the same reasons as a text key). A key someone owns is on from the start, is never a default, and is deleted with its owner.

## The caller's own keys (session)

| Route | What it does |
| --- | --- |
| `GET /api/me/voice-keys` | `{ keys, companies }`: the caller's keys, and the speech companies a key can be added for (`[{ adapter, label, recognition, speech, talk, logo, benefit, step, docs, account, ownServer? }]`). The companies are a fixed catalog (`lib/voice-key-companies.ts`, the game's connectors) of 14: `assemblyai`, `aws`, `azure`, `cartesia`, `deepgram`, `elevenlabs`, `fish`, `google`, `inworld`, `openai`, `soniox`, `ultravox`, `xai` and `zoom`. Every company in it is offered to everyone, with no setup by a super admin. A last entry, `openai-compatible`, is a speech server on the person's own computer, not a company: it has `ownServer: { steps }` and `account: null`. Each entry names what the company does and the models a key starts with; when the server has its own provider for a company switched on (the one Universe AI runs on), that provider's models are listed instead. `label`, `logo` (a file in `public/ai-providers/`, or `null`), `benefit`, `step` (how to get a key) and `docs` come from the catalog; `recognition`, `speech` and `talk` (it has a talking model) from the catalog's jobs plus what those providers do. `account` is what a key needs besides the key, or `null`: `address` (the person's own account address, Azure's resource endpoint), `regions` (`[{ id, label, host }]`, keys made per region, AWS), `keyId` and `keyLabel` (a key in two parts, AWS's access key ID and secret), `typedModel` (`{ title, label, hint, kind }`, a model the person types because the company has no list, an Azure deployment) |
| `POST /api/me/voice-keys/check` | "Load models": `{ adapter, apiKey, address?, region? }` (`address` for a company with `account.address` or an own server, `region` for one with `account.regions`). One free, authenticated call to the company with the key (nothing is saved, transcribed or spoken, so nothing is billed; the key goes only in one header to the company's own address and is never logged or returned), then 200 `{ ok: true, models }`: the union of the models the server's own providers with that adapter that are on list (`[{ id, label?, kind }]`, each kind and id once, ids exactly as the providers list them), or the catalog's starting models for the company when the server has none. `kind` is `recognition`, `speech` or `talk`. For a company with `account.typedModel` the answer is `{ ok: true, models: [], typed: true }`: the key was checked on the person's own `address`, and the person types the model. For an own server (`openai-compatible`) `apiKey` is optional and the answer is `{ ok: true, models, unsure, voices }`: `unsure` the model ids it lists without saying what they do (the person picks for each), `voices` how many voices it lists or `null`. `{ error }` with a plain sentence otherwise: 422 the company didn't accept the key (401/403), 502 it couldn't be reached (timeout, or any other answer), 400 the company isn't in the catalog or the key is missing or can't go in a header, 409 the company has no models (only when neither the server nor the catalog lists any), 429 too many tries (the limit the text keys' checks have). Each company's check call is in the catalog |
| `POST /api/me/voice-keys` | `{ adapter, name?, recognition?, speech?, apiKey, models?, endpoint?, region?, address? }`. `adapter` is one of `companies`, and the key can only do what that company does. The key listens, speaks or both; a company that talks live takes `recognition: true, speech: true` with its `talk` models, and a `talk` model on any other company is a 400. `endpoint` is the person's own account address, needed by a company with `account.address` (an https origin at that company's own domain) and refused by any other; `region` is one of `account.regions`, needed by a company that has them and refused by any other; a key in two parts is sent as one, the access key ID, a colon, then the secret. A company with `account.typedModel` takes exactly one model of that kind, named the way the company allows. An own server takes `address` (https, never a private network) and an optional `apiKey`. 201 with `{ key }` |
| `PATCH /api/me/voice-keys/:id` | Changes only what is named: `name`, `apiKey` (replaces the saved one), `models`, `limits` (below), and for an own server `address` (saved only once the new address answers with every model the key has). A `talk` model is refused on a company that doesn't talk live, as when the key was added. A model taken off the key is taken off every lend that named it; a lend left with none is pulled from that universe, as if the key were pulled (its bots there carry on in text) |
| `POST /api/me/voice-keys/:id/check` | "Check now" on a Down key: the next bot that needs it is let through to try, without waiting out the 5 minutes. Calls no provider. 200 with `{ key }`; a key that is not Down is left as it is |
| `DELETE /api/me/voice-keys/:id` | Takes the key away with every lend of it |
| `POST /api/me/voice-keys/:id/lend` | `{ universeId, models?, existing? }`. Needs the universe's owner, or Manage bots in it (the universes come from `GET /api/me/ai-keys/universes`). `models`: `null` = all of the key's, a list of `"kind:id"` = only these (each on the key's list), left out = as it is (all, for a new lend). Lending again is fine. `existing: true` changes a lend only: a lend pulled meanwhile is not made again, the answer is a 409 |
| `DELETE /api/me/voice-keys/:id/lend/:universeId` | Pulls the key from a universe. Always the key owner's to do |

Someone else's key, and a server provider, are 404. Lending moves no bot. A new `apiKey` on a Down key starts it clean: it is tried at once.

## When a key stops working

Orbit calls no provider, so the bot server tells it how each call went (service token): `POST /api/voice/providers/:id/health`
`{ part, ok: true, botId? }` or `{ part, ok: false, status?, rejected? }` (`part` is `recognition` or `speech`, the job the call was for) (`VOICE_PROVIDERS_API.md`). A speaking call that worked and names its `botId` is also one voice reply counted for that key, bot and month (`voice_key_usage`); a report without `botId` works as before and counts nothing. The rules are a text key's
(`lib/ai-key-health.ts`): a `401`, `403` or `rejected` is Down (`rejected`), a `402` is Down (`credit`), a `404` on listening (`recognition`) is Down (`model`), a `404` on speaking (`speech`) is not counted (the voice is each bot's own choice, so a missing voice never takes the key down),
two other failures in a row of the same job (a timeout, a `5xx`, a `429`) are Down (`errors`), a request the provider found wrong
(other `4xx`) is not counted, and a call that works marks the key Working again. Each job is counted on its own, so listening
that works does not hide speaking that keeps failing; a key that went Down on one job is Working again when that job works. The bot server sends `status` only for what the provider
said about the key, not for a voice or setting that bot's profile named wrongly.

While a key in a bot's profile is Down, `GET /api/bots/:id/voice/active` says `speaks: false, reason: "key-down"` with
`down: { since, reason }`, and the bot replies in text. Nothing switches to Universe AI's voice by itself; the bot stays in text
until the key's owner moves it in the profile or the key answers again. A Down key is tried again at most every 5 minutes, and
only when a bot needs it: the `active` read that is allowed the try says `speaks: true`, and the call's result decides.
