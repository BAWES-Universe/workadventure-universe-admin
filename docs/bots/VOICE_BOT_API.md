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
| `GET /api/bots/:id/voice` | `{ enabled, universeAllows, paidBy, parts, revision, draft: { profile, updatedAt }, revisions: [{ number, profile, note, publishedById, publishedAt }], lentKeys }`, revisions newest first. `lentKeys` are the keys the bot's maker lent to its universe that the profile may name: `[{ id, adapter, name, recognition, speech, last4, models }]`, `models` only the ones the lend allows, never the key |
| `PUT /api/bots/:id/voice` `{ enabled }` | Voice on or off. On needs the universe to allow it and a published profile whose providers work now (409); off always works |
| `PUT /api/bots/:id/voice/draft` | Saves the draft profile in place of the one there |
| `POST /api/bots/:id/voice/publish` `{ note? }` | Publishes the draft as the next revision. 400 when it is not finished; 409 when a provider is off, has no key, does not do that job or does not list the model |
| `POST /api/bots/:id/voice/rollback` `{ number }` | The bot speaks with that revision again (404 if there is none; 409 if its providers do not work as it says now). The draft stays as it is |

All answer with the same body as `GET`.

## Bot server (service token)

`GET /api/bots/:id/voice/active` gives `{ speaks, reason, paidBy, parts, revision, profile, down }`. `reason` is `null` when the bot speaks,
and otherwise `off`, `universe`, `no-profile`, `provider` or `key-down` (a person's key in the profile is Down: the bot replies in text, `down` is `{ since, reason }`, and one read every 5 minutes is let through to try it; see `VOICE_KEYS_API.md`). Read before each spoken turn: turning a provider or the universe's
switch off stops the bot at once, and a session keeps the `revision` it started with.

A lent key's credentials: `GET /api/voice/providers/:id/credentials?botId=…` (`VOICE_PROVIDERS_API.md`) serves the key, still
encrypted, only while that bot speaks with it. Without `botId`, or for any other bot, it is a 404.
