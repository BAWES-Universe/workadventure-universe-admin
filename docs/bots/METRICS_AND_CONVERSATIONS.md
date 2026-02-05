# Bot Metrics and Conversations API

## Overview

The Admin API provides endpoints for bot servers to store metrics, conversations, and memory data. This system supports high-volume metrics collection, conversation storage for admin viewing, and enhanced memory with emotions.

## Base URL

All bot endpoints are under: `/api/bots/`

## Authentication

Bot service endpoints require a **service token** via the `Authorization` header:

```
Authorization: Bearer <BOT_SERVICE_TOKEN>
```

Admin endpoints (viewing, cleanup, monitoring) require admin authentication (session token or `ADMIN_API_TOKEN`).

## Metrics Storage

### POST /api/bots/metrics

Store bot performance metrics (high volume, time-series data).

**Authentication:** `BOT_SERVICE_TOKEN`

**Request:**
```json
{
  "metrics": [
    {
      "botId": "bot-123",
      "timestamp": 1704067200000,
      "metrics": {
        "responseTime": 1250,
        "tokenUsage": { "prompt": 500, "completion": 200, "total": 700 },
        "repetitionScore": 0.1,
        "systemPromptLeakage": false,
        "personalityCompliance": 0.95,
        "conversationQuality": 0.9,
        "errorCount": 2
      },
      "metadata": { "playerId": 123, "spaceName": "room-456" }
    }
  ]
}
```

**Response:** `200 OK`
```json
{
  "saved": 7
}
```

**Notes:**
- Metrics are stored flattened - each field becomes a separate row
- Fire-and-forget pattern (non-blocking)
- High volume in development, low volume in production
- Timestamp converted from milliseconds to PostgreSQL TIMESTAMP

### GET /api/bots/:botId/metrics

Query metrics with filters.

**Authentication:** `BOT_SERVICE_TOKEN`

**Query Parameters:**
- `metricType` (optional): Filter by metric type
- `startTime` (optional): Start timestamp (milliseconds)
- `endTime` (optional): End timestamp (milliseconds)
- `limit` (optional, default: 100): Maximum results
- `offset` (optional, default: 0): Pagination offset

**Response:** `200 OK`
```json
[
  {
    "botId": "bot-123",
    "timestamp": 1704067200000,
    "metrics": {
      "responseTime": 1250,
      "tokenUsage": { "prompt": 500, "completion": 200, "total": 700 },
      "repetitionScore": 0.1,
      "systemPromptLeakage": false,
      "personalityCompliance": 0.95,
      "errorCount": 2
    },
    "metadata": { "playerId": 123 }
  }
]
```

**Notes:**
- Response reconstructs nested format from flattened database rows
- Metrics grouped by `(botId, timestamp)`

## Conversations

### POST /api/bots/:botId/conversations

Store conversation when it ends.

**Authentication:** `BOT_SERVICE_TOKEN`

**Request:**
```json
{
  "playerId": 456,
  "playerName": "John",
  "messages": [
    {
      "sender": "person",
      "message": "Hello",
      "timestamp": 1704067200000
    },
    {
      "sender": "bot",
      "message": "Hi there!",
      "timestamp": 1704067201000
    }
  ],
  "startedAt": 1704067200000,
  "endedAt": 1704067205000,
  "messageCount": 2
}
```

**Response:** `200 OK`
```json
{
  "status": "stored"
}
```

### GET /api/bots/:botId/conversations

Get conversations with filters.

**Authentication:** Admin (session or admin token)

**Query Parameters:**
- `limit` (optional, default: 50): Maximum results
- `offset` (optional, default: 0): Pagination offset
- `playerId` (optional): Filter by player ID
- `startDate` (optional): Start timestamp
- `endDate` (optional): End timestamp

**Response:** `200 OK`
```json
{
  "botId": "bot-123",
  "conversations": [...],
  "count": 10
}
```

### GET /api/bots/:botId/conversations/stats

Get conversation statistics.

**Authentication:** Admin

**Response:** `200 OK`
```json
{
  "botId": "bot-123",
  "totalConversations": 150,
  "oldestConversation": 1704067200000,
  "newestConversation": 1704153600000,
  "totalSize": 1048576
}
```

### DELETE /api/bots/:botId/conversations/cleanup

Cleanup conversations for a specific bot.

**Authentication:** Admin

**Query Parameters:**
- `olderThanDays` (optional): Delete conversations older than X days
- `keepRecent` (optional): Keep only last N conversations

**Response:** `200 OK`
```json
{
  "deletedCount": 50,
  "spaceFreed": 524288,
  "botsAffected": 1
}
```

### DELETE /api/bots/conversations/cleanup

Cleanup conversations across all bots.

**Authentication:** Admin

**Query Parameters:**
- `olderThanDays` (optional): Delete conversations older than X days
- `maxPerBot` (optional): Maximum conversations per bot
- `maxTotal` (optional): Maximum total conversations

**Response:** `200 OK`
```json
{
  "deletedCount": 500,
  "spaceFreed": 5242880,
  "botsAffected": 10
}
```

### GET /api/bots/:botId/conversations/cleanup/preview

Preview what will be deleted before cleanup.

**Authentication:** Admin

**Query Parameters:**
- `olderThanDays` (optional): Preview conversations older than X days
- `keepRecent` (optional): Preview keeping only last N conversations

**Response:** `200 OK`
```json
{
  "botId": "bot-123",
  "cleanupType": "olderThanDays",
  "cleanupValue": 7,
  "willDelete": {
    "conversationCount": 50,
    "estimatedSizeBytes": 5242880,
    "oldestToDelete": 1704067200000,
    "newestToDelete": 1704153600000
  },
  "willKeep": {
    "conversationCount": 100,
    "oldestKept": 1704153600000,
    "newestKept": 1704240000000
  }
}
```

## Memory and Emotions

### POST /api/bots/memory/:botId

Enhanced memory save - supports immediate emotion saves.

**Authentication:** `BOT_SERVICE_TOKEN`

**Request:**
```json
{
  "memories": [
    {
      "playerId": 123,
      "playerName": "John",
      "memories": [...],
      "emotions": {
        "botEmotion": { "anger": 10, "happiness": 80 },
        "personEmotion": { "anger": 5, "happiness": 75 }
      },
      "lastEmotionUpdate": 1704067200000
    }
  ],
  "timestamp": 1704067200000,
  "saveType": "immediate" | "periodic"
}
```

**Response:** `200 OK`
```json
{
  "status": "saved",
  "saveType": "immediate"
}
```

### GET /api/bots/:botId/emotions

Get bot emotions for admin UI.

**Authentication:** Admin

**Response:** `200 OK`
```json
[
  {
    "playerId": 123,
    "playerName": "John",
    "emotions": {
      "botEmotion": { "anger": 10, "happiness": 80 },
      "personEmotion": { "anger": 5, "happiness": 75 }
    },
    "lastEmotionUpdate": 1704067200000
  }
]
```

## Database Monitoring

### GET /api/bots/database/stats

Database monitoring - show what's bloating the DB.

**Authentication:** Admin

**Response:** `200 OK`
```json
{
  "metrics": {
    "table": "bots_metrics",
    "rowCount": 1500000,
    "sizeBytes": 524288000,
    "oldestRecord": 1704067200000,
    "newestRecord": 1704153600000,
    "recommendation": "Consider cleanup: 1.5M rows, 500MB"
  },
  "conversations": { ... },
  "memory": { ... },
  "testResults": { ... },
  "totalSizeBytes": 636354560,
  "totalSizeMB": 606.7,
  "recommendations": [
    "bots_metrics table is large (1.5M rows, 500MB). Consider cleanup."
  ]
}
```

## Development Features

### POST /api/bots/test/results

Store test results for regression testing.

**Authentication:** `BOT_SERVICE_TOKEN`

**Request:**
```json
{
  "testId": "test-123",
  "botId": "bot-123",
  "testSuite": "personality_compliance",
  "results": { ... },
  "passed": true
}
```

### GET /api/bots/metrics/cleanup/preview

Preview metrics cleanup.

**Authentication:** Admin

**Query Parameters:**
- `olderThanDays` (optional): Preview metrics older than X days
- `maxRows` (optional): Preview keeping only last N rows per bot

## Error Handling

**Service Token Endpoints:**
- Fire-and-forget: Return 200 OK even on errors (log errors)
- Don't block bot server operation

**Admin Endpoints:**
- Proper HTTP status codes (400, 401, 403, 404, 500)
- Detailed error messages
- Log all operations for audit trail

## Implementation Notes

- **Metrics flattening**: Each nested metric field becomes a separate database row
- **Metrics reconstruction**: GET endpoint groups rows by `(botId, timestamp)` and reconstructs nested format
- **Fire-and-forget**: Critical for metrics endpoint to not block bot server
- **Manual cleanup**: No automatic background jobs - admins control retention via cleanup endpoints
- **Database monitoring**: Use to identify when cleanup is needed
