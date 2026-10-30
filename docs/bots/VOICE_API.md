# Voice settings API (#740)

What Orbit keeps for voice bots. This page covers the universe switch and the voice limits; the per-bot voice and the
voice providers come in the next change.

## Allow voice bots here

A column on the universe, `allowVoiceBots`, on by default. Saved with the universe's own `PATCH /api/admin/universes/:id`
(`{ "allowVoiceBots": false }`) by the universe's owner or a super admin, and read back from `GET /api/admin/universes/:id`
with the rest of the universe.

## Voice limits

Every voice limit is a setting with a recommended default. Nothing is hardcoded in the game: it reads these, so a change
reaches it with no deploy.

| Limit | Name | Recommended | Values that can be saved |
| --- | --- | --- | --- |
| Text replies kept back: about 1 in this many replies in a window stay for text | `textReserveShare` | 6 | 2 to 100 |
| Voice replies a guest gets in a window | `guestVoiceReplies` | 3 | 0 to 1,000 |
| Longest spoken turn, seconds | `turnSeconds` | 180 | 5 to 3,600 |
| Longest spoken reply, characters | `replyCharacters` | 600 | 50 to 20,000 |
| Longest spoken reply, seconds | `replySeconds` | 60 | 5 to 600 |
| Minutes a day a bot listens for its name, all people together | `listenMinutesPerDay` | 60 | 0 to 1,440 |
| Seconds to keep going after an answer without the name | `followUpSeconds` | 30 | 5 to 600 |

All are whole numbers.

The replies kept for text out of a window of `W` replies are `min(W - 1, max(1, ceil(W / textReserveShare)))`, so 30 keeps
5 and 10 keeps 2. A window of 1 is text only. `W` is the fair usage window a super admin already sets
(`/api/admin/bot-limits`, `fairUsage`).

### `GET /api/voice/limits` (service token)

For the game. `Authorization: Bearer <BOT_SERVICE_TOKEN>`, never cached.

```json
{
  "revision": 0,
  "limits": { "textReserveShare": 6, "guestVoiceReplies": 3, "turnSeconds": 180, "replyCharacters": 600, "replySeconds": 60, "listenMinutesPerDay": 60, "followUpSeconds": 30 },
  "window": {
    "hours": 5,
    "signedIn": { "replies": 30, "textReserve": 5, "voiceReplies": 25 },
    "guest": { "replies": 10, "textReserve": 2, "voiceReplies": 3 }
  }
}
```

`revision` goes up by one with every save, so the game can tell when what it holds is old.

### `GET /api/admin/voice-limits` and `PATCH /api/admin/voice-limits` (super admin)

`GET` answers `{ limits, revision }`. `PATCH` takes any of the limits above, changes only the ones it names and answers
the same as `GET`. A value that is not a whole number inside its range, or a name that is not a limit, is a 400 with the
line that says which one.
