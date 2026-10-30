# Bot voice API (#740)

A bot's voice: on or off, a draft voice profile, and published revisions of it. Needs the voice providers
(`VOICE_PROVIDERS_API.md`) and the universe's "Allow voice bots here" (`VOICE_API.md`). Nothing here calls a provider.

Voice is **off** until a person with Manage bots turns it on. A bot speaks with the **revision** named in `bots.voice_revision`:
publishing makes a new revision and rolling back names an earlier one, so a published revision never changes. Every provider
is one a super admin runs, so Universe AI pays (`paidBy: "universe-ai"`); the person talking never does.

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
| `GET /api/bots/:id/voice` | `{ enabled, universeAllows, paidBy, revision, draft: { profile, updatedAt }, revisions: [{ number, profile, note, publishedById, publishedAt }] }`, revisions newest first |
| `PUT /api/bots/:id/voice` `{ enabled }` | Voice on or off. On needs the universe to allow it and a published profile whose providers work now (409); off always works |
| `PUT /api/bots/:id/voice/draft` | Saves the draft profile in place of the one there |
| `POST /api/bots/:id/voice/publish` `{ note? }` | Publishes the draft as the next revision. 400 when it is not finished; 409 when a provider is off, has no key, does not do that job or does not list the model |
| `POST /api/bots/:id/voice/rollback` `{ number }` | The bot speaks with that revision again (404 if there is none; 409 if its providers do not work as it says now). The draft stays as it is |

All answer with the same body as `GET`.

## Bot server (service token)

`GET /api/bots/:id/voice/active` gives `{ speaks, reason, paidBy, revision, profile }`. `reason` is `null` when the bot speaks,
and otherwise `off`, `universe`, `no-profile` or `provider`. Read before each spoken turn: turning a provider or the universe's
switch off stops the bot at once, and a session keeps the `revision` it started with.
