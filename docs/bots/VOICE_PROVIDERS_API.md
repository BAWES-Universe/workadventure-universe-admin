# Voice providers API (#740)

The speech companies a super admin sets up for the whole server. A provider can listen (recognition), speak (speech) or
both, and lists the models it can be used with. Which adapter runs it is the bot server's business; Orbit keeps its name,
where to reach it and its key. Orbit does call a provider's company for three free things: it asks whether a key is accepted (the check below), it
reads the company's list of voices, and it fetches a voice's sample. Nothing paid runs here: nothing is spoken or heard.

At most one provider is the default for listening and one for speaking. A bot on Universe AI follows them.

A provider: `{ id, adapter, name, recognition, speech, enabled, endpoint, region, hasKey, apiKeyLast4, models, defaultRecognition, defaultSpeech, defaultVoiceId, defaultVoiceName, updatedAt }`.
`adapter` is lowercase letters, numbers and dashes. `models` is `[{ id, label?, kind: "recognition" | "speech" }]`, each
kind one the provider does. The key is encrypted with `ENCRYPTION_KEY` and never sent to a browser.

## Super admin

| Route | What it does |
| --- | --- |
| `GET /api/admin/voice-providers` | `{ providers }`, never a key. Each also has `bots: { recognition, speech, total }`: how many bots with voice on listen and speak with it, and how many bots use it at all (one that does both counts once) |
| `POST /api/admin/voice-providers` | `{ adapter, name, recognition?, speech?, enabled?, endpoint?, region?, apiKey?, models? }`. Starts off. 201 with `{ provider }` |
| `GET /api/admin/voice-providers/:id` | `{ provider }` |
| `PATCH /api/admin/voice-providers/:id` | Changes only what is named. `apiKey: "..."` sets a key, `apiKey: null` takes it away. `defaultRecognition` / `defaultSpeech: true` takes the default from the provider that had it. `defaultVoiceId` (with `defaultVoiceName`, optional) is the voice Universe AI speaks with when a bot's maker turns voice on without a key of their own (game #1668); `null` takes it away. Only a provider that speaks can have one, a name needs its voice, and a new voice id without a name drops the old name. Unset, the bot page uses the first voice the provider lists |
| `DELETE /api/admin/voice-providers/:id` | Removes a provider that is not a default |
| `POST /api/admin/voice-providers/check` | `{ adapter, apiKey }` asks the company if it knows a key before a provider is added: one free call to the company's own address (the same one a person's own key gets), nothing spoken or heard, nothing billed. `{ ok: true }`, or `{ error }`: 422 turned away, 502 not reached, 400 not usable, 429 too many tries |
| `POST /api/admin/voice-providers/:id/check` | The same check for the key a provider holds (409 when it has none) |
| `GET /api/admin/voice-providers/:id/voices` | `{ voices: [{ voiceId, name, description, languages, previewUrl }] }`: the voices a provider that speaks lists with its company (free), for the starting voice, whether or not it is the default. 409 when the company's voices can't be listed here, 502 when it didn't answer |
| `GET /api/admin/voice-providers/:id/voices/:voiceId/preview` | One voice's sample, for a company that keeps samples behind the key (a voice whose `previewUrl` is this path) |

The model Universe AI starts a bot on is the first one the provider lists for that job, so the Universe AI page picks it by moving that model to the front of `models`.

A default must be on, hold its key and do its job (409 when a change would break that, 400 when asked for it). A provider
must listen, speak, or both. `endpoint` starts with `https://`, or `wss://` for a provider that only listens (Soniox and Deepgram listen on a websocket address); a provider that speaks needs `https://`.

## Bot server (service token)

- `GET /api/voice/providers` gives `{ providers: [{ id, adapter, name, recognition, speech, endpoint, region, models, hasKey }], defaults: { recognition: id | null, speech: id | null } }`: the providers that are on, without keys.
- `GET /api/voice/providers/:id/credentials[?botId=…]` gives one provider that is on and has a key, with `apiKeyEncrypted` still encrypted for the bot server to decrypt with `ENCRYPTION_KEY`, as for the text providers.

- `POST /api/voice/providers/:id/health` `{ part: "recognition" | "speech", ok: true, botId? }` or `{ part, ok: false, status?, rejected? }` tells Orbit how a call with a person's key went (`VOICE_KEYS_API.md`, "When a key stops working"). `botId` is optional: on a speaking call that worked it counts one voice reply for that key, bot and month, which the key's owner sees under "This month". Answers `{ status, downSince, downReason }`. A server provider, which has no owner and no health, and a key that is not there are 404.

A key a person lent (`VOICE_KEYS_API.md`) is never in `GET /api/voice/providers`. Its credentials are served only with `botId`, and only while that bot speaks with it (404 otherwise); a bot let through to try a Down key is still served it.
