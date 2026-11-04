# Bot voice API (#740)

A bot's voice: on or off, a draft voice profile, and published revisions of it. Needs the voice providers
(`VOICE_PROVIDERS_API.md`) and the universe's "Allow voice bots here" (`VOICE_API.md`). Nothing here calls a provider.

Voice is **off** until a person with Manage bots turns it on. A bot speaks with the **revision** named in `bots.voice_revision`:
publishing makes a new revision and rolling back names an earlier one, so a published revision never changes. A provider is
one a super admin runs, so Universe AI pays, or a key the bot's maker lent to its universe (`VOICE_KEYS_API.md`, #749), so the
maker pays; the person talking never does.

**Who pays.** `paidBy` is `"universe-ai"`, `"owner"` (both parts on lent keys) or `"mixed"`, and `parts` says it for each
part: `{ recognition, speech }`, each `"universe-ai"` or `"owner"`. It describes the revision the bot speaks with.

**A lent key.** A profile may name a key only when the bot's maker owns it, has lent it to the bot's universe with the model
(a lend can allow only some of the key's models), and still owns that universe or has Manage bots in it. Anything else reads
as a provider that does not exist (409 on publish and roll back). The key is never used on anyone else's bot. When it stops
being usable later (pulled, deleted, a model taken off, its owner no longer able to manage bots there) the bot carries on in
text only: `speaks` is `false` and `reason` is `provider`, and it speaks again by itself when the key is back.

A profile:

```json
{
  "recognition": { "providerId": "…", "model": "…" },
  "speech": { "providerId": "…", "model": "…", "voiceId": "…", "voiceName": "…" },
  "expression": "restrained" | "natural" | "expressive",
  "language": { "mode": "follow" } | { "mode": "fixed", "code": "ar-KW" }
}
```

`voiceName` is optional. A draft may leave any part out. A published profile has `recognition` and `speech`; `expression`
starts at `natural` and `language` at `follow`.

## People with Manage bots for the bot

| Route | What it does |
| --- | --- |
| `GET /api/bots/:id/voice` | `{ enabled, universeAllows, paidBy, parts, revision, draft: { profile, updatedAt }, revisions: [{ number, profile, note, publishedById, publishedAt }], lentKeys }`, revisions newest first. `lentKeys` are the keys the bot's maker lent to its universe that the profile may name: `[{ id, adapter, name, recognition, speech, last4, models, health, month, limits }]`, `models` only the ones the lend allows, never the key. Also `universeAi` and `voiceLimits` (below) |
| `PUT /api/bots/:id/voice` `{ enabled }` | Voice on or off. On needs the universe to allow it and a published profile whose providers work now (409); off always works |
| `PUT /api/bots/:id/voice/draft` | Saves the draft profile in place of the one there |
| `POST /api/bots/:id/voice/publish` `{ note? }` | Publishes the draft as the next revision. 400 when it is not finished; 409 when a provider is off, has no key, does not do that job or does not list the model |
| `POST /api/bots/:id/voice/rollback` `{ number }` | The bot speaks with that revision again (404 if there is none; 409 if its providers do not work as it says now). The draft stays as it is |

All answer with the same body as `GET`.

### What the bot page also reads from `GET` (game #1668)

- `lentKeys[]` also carry `health` (`{ status: "working" | "down", downSince, downReason }`, the same as on the AI keys page), `month`
  (`{ voiceReplies, botVoiceReplies }`: the voice replies the key paid for this month (UTC), all its bots' and this bot's, display only)
  and `limits` (`{ turnSeconds, replyCharacters, replySeconds, listenMinutesPerDay }`, each `{ value, recommended, changed }`: the key's
  own value, or the server's).
- `universeAi` is what Universe AI starts from: `{ recognition, speech }`, each null when the server has no usable default provider for
  that job (it has no key, is off, or lists no model for it). A job is `{ providerId, adapter, name, model, models: [{ id, label }] }`: the
  default provider and the first model it lists. Speech also has `defaultVoice`, `{ voiceId, voiceName }` as a super admin set it on the
  provider (`VOICE_PROVIDERS_API.md`, `defaultVoiceId`), or null: then take the first voice the voice list returns. Never the key.
- `voiceLimits` is `GET /api/voice/limits` (`revision`, `limits`, `window` with the voice replies a fair-usage window leaves), so the
  page shows the server's numbers and types none.

## Voices to pick from (game #1668)

`GET /api/bots/:id/voice/voices?part=speech&source=universe-ai|<keyId>`: the speaking voices of one source, straight from the voice
company's own free list call (nothing is spoken or billed). `source` is `universe-ai` (the server's default speaking provider) or the id
of a key from `lentKeys`. Answers

```json
[{ "voiceId": "…", "name": "…", "description": "…", "languages": ["en", "ar"], "previewUrl": "…" | null, "providerId": "…", "model": "…" }]
```

in the company's order. `languages` are lowercase codes without region, as the company lists them (empty when it does not say). `model` is
the speaking model to use with the voice: the first one the source lists, and for a key the first the lend allows. `providerId` and
`model` go in the draft's `speech` with `voiceId` and `voiceName`.

- **Who:** Manage bots for this bot, as the other routes. A key is listed only when the bot's maker owns it, has lent it to the bot's
  universe and may still lend there: anything else is a 404 ("Voice key not found."), so a key's existence is never confirmed.
- **Companies:** ElevenLabs and Cartesia. Others (Deepgram and Soniox only listen) answer 409 "…voices can't be listed here.". Part
  `recognition` is a 400: there are no voices to pick for listening.
- **Errors:** 409 when Universe AI has no voice set up on the server, or the source has no speaking model; 502 when the company turns the key
  away or does not answer (the line says which; never the key).
- **Cache:** per provider for 10 minutes, dropped when the key or address is replaced. Failures are not cached. At most 1000 voices.
- **Samples:** `previewUrl` is the company's own public address when it has one (ElevenLabs), else the Orbit path
  `GET /api/bots/:id/voice/voices/:voiceId/preview?source=…` when the company only serves a sample with the key (Cartesia). That route
  fetches the sample from the address the company's own list named (never one in the request) with the key, and answers the audio (up to
  2 MB, cached privately for a day); like the list it needs the person's session, so the game fetches it the way it fetches the list and
  plays the bytes. 404 for a voice with no sample, 502 when the company does not answer. A sample address that is not https, or that is at
  another host than the company's, is left out.

## Bot server (service token)

`GET /api/bots/:id/voice/active` gives `{ speaks, reason, paidBy, parts, revision, profile, down, limits }`. `reason` is `null` when the bot speaks,
and otherwise `off`, `universe`, `no-profile`, `provider` or `key-down` (a person's key in the profile is Down: the bot replies in text, `down` is `{ since, reason }`, and one read every 5 minutes is let through to try it; see `VOICE_KEYS_API.md`). `limits` is the server's voice limits (the same as `GET /api/voice/limits`: `turnSeconds`, `replyCharacters`, `replySeconds`, `listenMinutesPerDay`, `followUpSeconds`, `textReserveShare`, `guestVoiceReplies`), except that a part that runs on a person's lent key takes the values its owner set on that key (`VOICE_KEYS_API.md`): `turnSeconds` and `listenMinutesPerDay` from the listening key, `replyCharacters` and `replySeconds` from the speaking key. Every other limit is the server's, and a value the owner never changed follows the server's. Read before each spoken turn: turning a provider or the universe's
switch off stops the bot at once, and a session keeps the `revision` it started with.

A lent key's credentials: `GET /api/voice/providers/:id/credentials?botId=…` (`VOICE_PROVIDERS_API.md`) serves the key, still
encrypted, only while that bot speaks with it. Without `botId`, or for any other bot, it is a 404.

## Spoken replies and the Universe AI allowance (game #1669)

A spoken reply comes out of the same Universe AI window as a text reply (5 hours; 30 replies signed in, 10 for a guest). Some replies
are always kept for text, and a guest hears at most a few. These come from the voice limits (`textReserveShare`, `guestVoiceReplies`),
so a super admin changes them with no deploy: `GET /api/voice/limits` gives the replies that leave per window as `window.signedIn.voiceReplies`
(30 gives 25) and `window.guest.voiceReplies` (10 gives 3).

`POST /api/bots/:id/voice-allowance` (service token) with `{ userId, isGuest, turnId }`: may this reply be spoken? The bot server asks it just
before it says a reply that Universe AI pays for (a voice part whose `parts` value is `universe-ai`). It answers `{ allowed: true, left, resetsAt }`
(`left`: spoken replies still possible after this one; `resetsAt`: when the person's window ends), or `{ allowed: false, resetsAt }` when
the person has none left; the reply then stays in text. What is left is the voice replies the limits give (30 gives 25) less the spoken
ones, and never more than what is left of the window once the replies kept for text are put aside, so replies a person typed count too. A reply is counted
under its `turnId` (up to 255 characters), so asking again for the same one (a retry, a reconnect) never counts it twice. A person the
bot can't name yet (no `userId`) is never stopped. The text of the reply is counted as ever, in the usage rows; this only counts which
replies were also spoken (`voice_reply_uses`), in the same window as the person's Universe AI replies.

`POST /api/bots/:id/voice-allowance/left` (service token) with `{ userId, isGuest }`: how many spoken replies the person has left, for the line at
the bottom of their Voice menu. It counts nothing and starts no window. It answers `{ left, resetsAt }`, with `resetsAt` null while no window
is running (nothing used yet, or the last one ended), or `{ left: null, resetsAt: null }` for a person the bot can't name.

`POST /api/bots/:id/voice-allowance/release` (service token) with `{ turnId }`: gives back a counted reply that was never played (a person
talked over it while it was being settled, a greeting that waited for audio ran out of time, the voice provider failed). It answers
`{ released: true }` when it gave one back and `{ released: false }` when there was none (never counted, or already given back), so it is safe
to ask twice. A reply asked for again afterwards is counted again, as a new one.

`POST /api/bots/:id/reply-allowance` takes an optional `greeting: true` for a greeting a voice bot makes on its own: it is turned down once
only the replies kept for text are left, and a greeting that is turned down is not counted as someone running out.
