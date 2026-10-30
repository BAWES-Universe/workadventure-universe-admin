# Voice providers API (#740)

The speech companies a super admin sets up for the whole server. A provider can listen (recognition), speak (speech) or
both, and lists the models it can be used with. Which adapter runs it is the bot server's business; Orbit keeps its name,
where to reach it and its key. Nothing in Orbit calls a provider: no key is tested here and nothing paid runs.

At most one provider is the default for listening and one for speaking. A bot on Universe AI follows them.

A provider: `{ id, adapter, name, recognition, speech, enabled, endpoint, region, hasKey, apiKeyLast4, models, defaultRecognition, defaultSpeech, updatedAt }`.
`adapter` is lowercase letters, numbers and dashes. `models` is `[{ id, label?, kind: "recognition" | "speech" }]`, each
kind one the provider does. The key is encrypted with `ENCRYPTION_KEY` and never sent to a browser.

## Super admin

| Route | What it does |
| --- | --- |
| `GET /api/admin/voice-providers` | `{ providers }`, never a key |
| `POST /api/admin/voice-providers` | `{ adapter, name, recognition?, speech?, enabled?, endpoint?, region?, apiKey?, models? }`. Starts off. 201 with `{ provider }` |
| `GET /api/admin/voice-providers/:id` | `{ provider }` |
| `PATCH /api/admin/voice-providers/:id` | Changes only what is named. `apiKey: "..."` sets a key, `apiKey: null` takes it away. `defaultRecognition` / `defaultSpeech: true` takes the default from the provider that had it |
| `DELETE /api/admin/voice-providers/:id` | Removes a provider that is not a default |

A default must be on, hold its key and do its job (409 when a change would break that, 400 when asked for it). A provider
must listen, speak, or both. `endpoint` starts with `https://`.

## Bot server (service token)

- `GET /api/voice/providers` gives `{ providers: [{ id, adapter, name, recognition, speech, endpoint, region, models, hasKey }], defaults: { recognition: id | null, speech: id | null } }`: the providers that are on, without keys.
- `GET /api/voice/providers/:id/credentials[?botId=…]` gives one provider that is on and has a key, with `apiKeyEncrypted` still encrypted for the bot server to decrypt with `ENCRYPTION_KEY`, as for the text providers.

A key a person lent (`VOICE_KEYS_API.md`) is never in `GET /api/voice/providers`. Its credentials are served only with `botId`, and only while that bot speaks with it (404 otherwise).
