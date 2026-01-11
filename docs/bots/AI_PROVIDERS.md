# AI Provider Management - Bot Server Integration Guide

## Overview

The Admin API provides endpoints for bot servers to fetch AI provider credentials and track usage. This system supports multiple AI provider types (LMStudio, OpenAI, Anthropic, Ultravox, GPT Voice) with secure credential storage and usage tracking.

## Base URL

All bot server endpoints are under: `/api/bots/`

## Authentication

All bot server endpoints require a **service token** via the `Authorization` header:

```
Authorization: Bearer <BOT_SERVICE_TOKEN>
```

The `BOT_SERVICE_TOKEN` is a simple string (not JWT) that must match the value configured in the Admin API's environment variables.

**Important:** This is separate from `ADMIN_API_TOKEN`. Use `BOT_SERVICE_TOKEN` for bot server requests.

## Environment Variables

The bot server needs these environment variables:

1. **`BOT_SERVICE_TOKEN`** - Service token for authentication (must match Admin API's `BOT_SERVICE_TOKEN`)
2. **`ENCRYPTION_KEY`** - 32-byte (64 hex characters) key for decrypting credentials (must match Admin API's `ENCRYPTION_KEY`)
3. **`ADMIN_API_URL`** - Base URL of the Admin API (e.g., `https://admin-api.example.com`)

---

## Endpoints

### 1. List Available Providers

**Endpoint:** `GET /api/bots/ai-providers`

**Purpose:** Get a list of available AI providers (for dropdown/selection in bot configuration).

**Authentication:** Service token (`BOT_SERVICE_TOKEN`)

**Query Parameters:**
- `enabled` (optional, boolean): Filter by enabled status (e.g., `?enabled=true`)
- `type` (optional, string): Filter by provider type (e.g., `?type=openai`)

**Request Example:**
```http
GET /api/bots/ai-providers?enabled=true
Authorization: Bearer your-bot-service-token
```

**Response Example:**
```json
[
  {
    "providerId": "lmstudio-local",
    "name": "LMStudio Local",
    "type": "lmstudio",
    "enabled": true,
    "supportsStreaming": true
  },
  {
    "providerId": "openai-production",
    "name": "OpenAI GPT-4",
    "type": "openai",
    "enabled": true,
    "supportsStreaming": true
  }
]
```

**Response Codes:**
- `200 OK` - Success
- `401 Unauthorized` - Invalid service token

**Note:** This endpoint does NOT return credentials or sensitive data, only metadata.

---

### 2. Get Provider Credentials

**Endpoint:** `GET /api/bots/ai-providers/:providerId/credentials`

**Purpose:** Fetch full provider configuration including encrypted credentials. The bot server uses the `aiProviderRef` from bot configuration to fetch credentials.

**Authentication:** Service token (`BOT_SERVICE_TOKEN`) - REQUIRED

**Request Example:**
```http
GET /api/bots/ai-providers/lmstudio-local/credentials
Authorization: Bearer your-bot-service-token
```

**Response Example:**
```json
{
  "providerId": "lmstudio-local",
  "name": "LMStudio Local",
  "type": "lmstudio",
  "enabled": true,
  "endpoint": "http://localhost:1234",
  "apiKeyEncrypted": "a1b2c3d4e5f6:g7h8i9j0k1l2:encrypteddatahex...",
  "model": "local-model",
  "temperature": 0.7,
  "maxTokens": 500,
  "supportsStreaming": true,
  "settings": {
    "timeout": 30000
  }
}
```

**Response Codes:**
- `200 OK` - Credentials returned
- `401 Unauthorized` - Invalid service token
- `404 Not Found` - Provider not found
- `400 Bad Request` - Provider is not enabled

**Important Security Notes:**
1. **`apiKeyEncrypted` is encrypted** (format: `iv:authTag:encryptedData` - all hex strings)
2. If the provider doesn't need an API key (e.g., LMStudio), `apiKeyEncrypted` will be `null`
3. **Bot server must decrypt** using `ENCRYPTION_KEY` environment variable
4. Credentials are only returned if the provider is `enabled: true`

---

### 3. Track AI Usage

**Endpoint:** `POST /api/bots/ai-usage`

**Purpose:** Track AI usage (tokens, API calls, costs) for analytics and billing. This is **fire-and-forget** - don't block bot operation if tracking fails.

**Authentication:** Service token (`BOT_SERVICE_TOKEN`) - REQUIRED

**Request Example (Text AI - LMStudio, OpenAI, Anthropic):**
```http
POST /api/bots/ai-usage
Authorization: Bearer your-bot-service-token
Content-Type: application/json

{
  "botId": "bot-123",
  "providerId": "lmstudio-local",
  "tokensUsed": 150,
  "apiCalls": 1,
  "latency": 1250,
  "durationSeconds": null,
  "cost": 0.0015,
  "error": false,
  "timestamp": "2025-01-09T12:00:00Z"
}
```

**Request Example (Voice AI - Ultravox, GPT Voice):**
```http
POST /api/bots/ai-usage
Authorization: Bearer your-bot-service-token
Content-Type: application/json

{
  "botId": "bot-123",
  "providerId": "ultravox-production",
  "tokensUsed": 0,
  "apiCalls": 1,
  "latency": 1250,
  "durationSeconds": 150,
  "cost": 0.15,
  "error": false,
  "timestamp": "2025-01-09T12:00:00Z"
}
```

**Request Body Fields:**
- `botId` (required, string): Bot identifier
- `providerId` (required, string): Provider ID from configuration
- `tokensUsed` (optional, number, default: 0): Number of tokens used (0 for voice AI)
- `apiCalls` (optional, number, default: 1): Number of API calls made
- `durationSeconds` (optional, number, nullable): Duration in seconds (for voice AI only, null for text AI)
- `cost` (optional, number, nullable): Calculated cost in USD/credits
- `latency` (optional, number, nullable): Request latency in milliseconds
- `error` (optional, boolean, default: false): Whether the request resulted in an error
- `timestamp` (optional, ISO 8601 string, default: now): When the usage occurred

**Response Example:**
```json
{
  "status": "tracked"
}
```

**Response Codes:**
- `200 OK` - Usage tracked (always returns success, even on errors - fire-and-forget)

**Important Notes:**
- This endpoint is **fire-and-forget** - it always returns `200 OK` even if tracking fails
- Don't block bot operation waiting for this response
- Track usage asynchronously if possible
- The endpoint validates that the provider exists before tracking

---

## Encryption Implementation

### Encryption Format

Credentials are encrypted using **AES-256-GCM** and returned in the format:
```
iv:authTag:encryptedData
```

All three parts are hex-encoded strings, separated by colons.

### Decryption Function (Node.js Example)

```typescript
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  
  // Key is 64 hex characters (32 bytes)
  if (key.length === 64) {
    return Buffer.from(key, 'hex');
  }
  
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
}

function decryptApiKey(encrypted: string): string {
  if (!encrypted) {
    throw new Error('Encrypted data cannot be empty');
  }

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format. Expected "iv:authTag:encryptedData"');
  }

  const [ivHex, authTagHex, encryptedData] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

### Usage in Bot Server

```typescript
// Fetch credentials
const response = await fetch(`${ADMIN_API_URL}/api/bots/ai-providers/${providerId}/credentials`, {
  headers: {
    'Authorization': `Bearer ${BOT_SERVICE_TOKEN}`,
  },
});

const provider = await response.json();

// Decrypt API key if present
let apiKey: string | null = null;
if (provider.apiKeyEncrypted) {
  apiKey = decryptApiKey(provider.apiKeyEncrypted);
}

// Use provider config
const config = {
  endpoint: provider.endpoint,
  apiKey: apiKey, // null if not needed (e.g., LMStudio)
  model: provider.model,
  temperature: provider.temperature,
  maxTokens: provider.maxTokens,
  supportsStreaming: provider.supportsStreaming,
  settings: provider.settings,
};
```

---

## Integration Flow

### 1. Bot Configuration

Bot configuration includes `aiProviderRef` field:
```json
{
  "botId": "bot-123",
  "name": "Assistant Bot",
  "aiProviderRef": "lmstudio-local"
}
```

### 2. Fetch Credentials

When bot needs to use AI:
1. Read `aiProviderRef` from bot configuration
2. Call `GET /api/bots/ai-providers/:providerId/credentials`
3. Decrypt `apiKeyEncrypted` using `ENCRYPTION_KEY`
4. Use decrypted credentials to call AI provider

### 3. Track Usage

After each AI API call:
1. Calculate usage metrics (tokens, cost, latency, etc.)
2. Call `POST /api/bots/ai-usage` asynchronously (fire-and-forget)
3. Don't wait for response - continue bot operation

---

## Cost Calculation

The bot server is responsible for calculating costs based on provider pricing:

- **LMStudio**: Calculate based on your pricing model (per token, per request, etc.)
- **OpenAI/Anthropic**: Use actual API cost (or your markup)
- **Ultravox/GPT Voice**: Calculate per minute (e.g., $0.05 per minute, rounded up)

Send the calculated cost in the `cost` field of the usage tracking request.

---

## Duration Field

- **Text AI** (LMStudio, OpenAI, Anthropic): Set `durationSeconds` to `null` (not applicable)
- **Voice AI** (Ultravox, GPT Voice): Set `durationSeconds` to the actual duration in seconds

---

## Error Handling

### Authentication Errors (401)

If you receive `401 Unauthorized`:
1. Verify `BOT_SERVICE_TOKEN` is correct
2. Verify token is sent in `Authorization: Bearer <token>` header
3. Contact admin to verify token is configured

### Provider Not Found (404)

If provider doesn't exist:
1. Verify `providerId` matches exactly (case-sensitive)
2. Check that provider exists in Admin API
3. Verify provider is enabled

### Provider Not Enabled (400)

If provider is disabled:
1. Provider exists but `enabled: false`
2. Contact admin to enable the provider
3. Don't retry until provider is enabled

### Decryption Errors

If decryption fails:
1. Verify `ENCRYPTION_KEY` matches Admin API's key
2. Verify key is 64 hex characters (32 bytes)
3. Log error and fail gracefully (don't expose encryption errors to end users)

---

## Testing

### Test Credentials Endpoint

```bash
curl -X GET "https://admin-api.example.com/api/bots/ai-providers/lmstudio-local/credentials" \
  -H "Authorization: Bearer your-bot-service-token"
```

### Test Usage Tracking

```bash
curl -X POST "https://admin-api.example.com/api/bots/ai-usage" \
  -H "Authorization: Bearer your-bot-service-token" \
  -H "Content-Type: application/json" \
  -d '{
    "botId": "test-bot",
    "providerId": "lmstudio-local",
    "tokensUsed": 100,
    "apiCalls": 1,
    "cost": 0.001,
    "error": false
  }'
```

---

## Implementation Checklist

For bot server implementation:

- [ ] Set `BOT_SERVICE_TOKEN` environment variable
- [ ] Set `ENCRYPTION_KEY` environment variable (64 hex characters)
- [ ] Set `ADMIN_API_URL` environment variable
- [ ] Implement service token authentication (Bearer token in Authorization header)
- [ ] Implement decryption function for `apiKeyEncrypted` field
- [ ] Implement credential fetching using `aiProviderRef` from bot config
- [ ] Implement usage tracking (fire-and-forget, async)
- [ ] Handle `null` API keys gracefully (some providers don't need keys)
- [ ] Calculate costs based on provider type
- [ ] Set `durationSeconds` correctly (null for text AI, actual seconds for voice AI)
- [ ] Handle errors gracefully (don't block bot operation)

---

## Security Notes

1. **Credentials remain encrypted in transit** - The Admin API returns `apiKeyEncrypted` (encrypted string), not decrypted credentials
2. **Bot server decrypts** - Bot server must decrypt using `ENCRYPTION_KEY` (defense in depth)
3. **Service token is separate** - `BOT_SERVICE_TOKEN` is different from `ADMIN_API_TOKEN`
4. **Simple token comparison** - Service token uses simple env var comparison (not JWT)
5. **No permission checking** - All service tokens have the same access level

---

## Support

If you encounter issues:
1. Verify environment variables are set correctly
2. Check Admin API logs for errors
3. Verify provider exists and is enabled in Admin API
4. Test endpoints using curl/Postman first
5. Contact the Admin API team with specific error messages

