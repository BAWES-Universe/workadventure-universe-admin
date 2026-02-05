# GET Bot Memory — Brief for Bot Team

## Endpoint

**GET** `/api/bots/memory/:botId`

Returns all stored memory entries for a bot. Use this on bot server startup to restore emotional state, wounds, and conversation history so memories persist across restarts.

---

## Base URL

Use your Admin API base URL, e.g.:

`https://your-admin-api.example.com/api/bots/memory/:botId`

---

## Authorization

Send one of:

- **BOT_SERVICE_TOKEN** (recommended for bot server):  
  `Authorization: Bearer <BOT_SERVICE_TOKEN>`
- **ADMIN_API_TOKEN** (for admin/script access):  
  `Authorization: Bearer <ADMIN_API_TOKEN>`

If the token is missing or invalid, the API returns **401 Unauthorized**.

---

## Query Parameters (optional)

| Parameter  | Type   | Description                                  |
|-----------|--------|----------------------------------------------|
| `userUuid`| string | If set, only the memory for this user is returned. Omit to get all users for the bot. |

**Examples:**

- All memories for the bot:  
  `GET /api/bots/memory/75f5ac5e-ea6b-482f-902b-714806b20424`
- One user’s memory:  
  `GET /api/bots/memory/75f5ac5e-ea6b-482f-902b-714806b20424?userUuid=623769b7-6e82-4998-acfe-7b5d18373c5f`

---

## Response Format

**Content-Type:** `application/json`

### 200 OK

Body is an object with a single key `memories`: an array of memory entries. Each entry has the same shape the Admin API expects when **saving** memory (so you can round-trip: GET → modify → POST).

```json
{
  "memories": [
    {
      "userUuid": "khalid@bawes.net",
      "userId": "clx...",
      "userName": "Khalid ABC",
      "isGuest": false,
      "memories": {
        "personalInfo": {
          "name": "Khalid",
          "birthday": "2026-01-15",
          "facts": [["key", "value"]]
        },
        "relationship": {
          "firstMet": 1704067200000,
          "lastMet": 1704153600000,
          "totalConversations": 5,
          "totalMessages": 23,
          "importantEvents": []
        },
        "conversationHistory": [],
        "lastUpdated": 1704153600000,
        "createdAt": 1704067200000
      },
      "emotions": {
        "botEmotion": {
          "anger": 0,
          "happiness": 50,
          "trust": 50,
          "familiarity": 5
        },
        "personEmotion": {
          "anger": 0,
          "happiness": 50,
          "trust": 50
        },
        "wounds": [],
        "recentSentiment": 0,
        "lastEmotionUpdate": 1704153600000
      }
    }
  ]
}
```

- When the bot has **no** stored memories, the API still returns **200 OK** with:
  ```json
  { "memories": [] }
  ```
- `userId` is the Admin API’s User id (string UUID), or `null` for guests.
- `memories` and `emotions` are returned as stored; either can be `null` for a given entry.
- `lastEmotionUpdate` (epoch ms) is included in each entry’s `emotions` when available.

---

## Response Codes

| Code | Meaning |
|------|--------|
| **200 OK** | Success. Body is `{ "memories": [ ... ] }`. Use `memories: []` when there are no memories. |
| **401 Unauthorized** | Invalid or missing token. |
| **500 Internal Server Error** | Server error; retry with backoff. |

There is no 404 for “no memories”; that case is 200 with `memories: []`.

---

## Implementation Notes for Bot Team

1. **On startup**  
   Call `GET /api/bots/memory/:botId` (with your bot id). Restore in-memory state from the returned `memories` array (emotions, wounds, conversation history, etc.).

2. **Round-trip**  
   The response shape matches what `POST /api/bots/memory/:botId` accepts per user. You can GET, update in memory, then POST to save.

3. **Optional filter**  
   Use `?userUuid=...` only when you need one user’s memory (e.g. a single reconnecting user). For full restore, omit it.

4. **CORS**  
   If the bot server runs in the browser, use the same origin or ensure the Admin API allows your origin. Server-to-server calls do not depend on CORS.

---

## Changelog

- **Initial**: GET implemented; returns all memories for the bot (or filtered by `userUuid`). 200 + `{ "memories": [] }` when none. Auth: BOT_SERVICE_TOKEN or ADMIN_API_TOKEN.
