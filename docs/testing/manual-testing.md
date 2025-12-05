# Manual Testing Guide

Quick reference for testing the WorkAdventure Admin API.

## Authentication

All API endpoints require Bearer token authentication:

```
Authorization: Bearer {ADMIN_API_TOKEN}
```

## Quick Start

### 1. Get Your Token

Check your `.env.local` file:
```bash
grep ADMIN_API_TOKEN .env.local
```

If not set, add it:
```env
ADMIN_API_TOKEN=dev-admin-api-token-change-in-production
```

### 2. Test the API

#### Using cURL

```bash
# Set token variable
export TOKEN="dev-admin-api-token-change-in-production"

# Test capabilities endpoint
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/capabilities

# Expected response:
# {
#   "api/woka/list": "v1",
#   "api/save-name": "v1",
#   "api/save-textures": "v1",
#   "api/ice-servers": "v1"
# }
```

#### Using Postman

1. Create a new GET request
2. URL: `http://localhost:3000/api/capabilities`
3. Authorization tab → Type: Bearer Token
4. Token: `dev-admin-api-token-change-in-production`
5. Send

#### Using HTTPie

```bash
http GET http://localhost:3000/api/capabilities \
  Authorization:"Bearer dev-admin-api-token-change-in-production"
```

## Testing All Endpoints

### Core Endpoints

```bash
TOKEN="dev-admin-api-token-change-in-production"
BASE="http://localhost:3000"

# 1. Capabilities
curl -H "Authorization: Bearer $TOKEN" $BASE/api/capabilities

# 2. Map
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room"

# 3. Room Access
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1"
```

### Member Endpoints

```bash
# Search members
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/members?playUri=http://play.workadventure.localhost/@/universe/world/room&searchText=john"

# Get member by UUID
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/members/998ce839-3dea-4698-8b41-ebbdf7688ad9"
```

### Woka & Companion Endpoints

```bash
# Get woka list
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/woka/list?roomUrl=http://play.workadventure.localhost/@/universe/world/room&uuid=test-user"

# Get companion list
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/companion/list?roomUrl=http://play.workadventure.localhost/@/universe/world/room&uuid=test-user"
```

### Moderation Endpoints

```bash
# Check ban status
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/ban?token=test-user&ipAddress=127.0.0.1&roomUrl=http://play.workadventure.localhost/@/universe/world/room"

# Ban a user (POST)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "uuidToBan": "user-uuid-here",
    "playUri": "http://play.workadventure.localhost/@/universe/world/room",
    "name": "Test User",
    "message": "Test ban",
    "byUserUuid": "admin-uuid-here"
  }' \
  $BASE/api/ban
```

## Testing with WorkAdventure

### Setup

1. **Configure WorkAdventure** to use your Admin API:
   ```env
   ADMIN_API_URL=http://localhost:3000
   ADMIN_API_TOKEN=dev-admin-api-token-change-in-production
   ```

2. **Start WorkAdventure** (if using Docker):
   ```bash
   docker-compose up
   ```

3. **Start your Admin API**:
   ```bash
   npm run dev
   ```

### Test Flow

1. **Open WorkAdventure** in your browser:
   ```
   http://play.workadventure.localhost/@/universe/world/room
   ```

2. **Watch your API logs** - You should see requests like:
   ```
   GET /api/map 200 in 45ms
   GET /api/room/access 200 in 23ms
   GET /api/capabilities 200 in 12ms
   ```

3. **Check the browser console** for any errors

## Troubleshooting

### 401 Unauthorized

**Problem**: Token authentication failed

**Solutions**:
- Verify `ADMIN_API_TOKEN` is set in `.env.local`
- Check the token in your request header matches exactly
- Ensure no extra spaces or newlines in the token
- Restart the dev server after changing `.env.local`

### Connection Refused

**Problem**: Cannot connect to `http://localhost:3000`

**Solutions**:
- Verify the dev server is running: `npm run dev`
- Check the port (default is 3000)
- Try accessing `http://localhost:3000/api/capabilities` in browser (will fail auth but confirms server is up)

### Token Mismatch with WorkAdventure

**Problem**: WorkAdventure can't authenticate with your API

**Solutions**:
- Ensure both use the same `ADMIN_API_TOKEN`
- Check WorkAdventure's environment variables
- Restart both services after changing tokens
- Check WorkAdventure logs for authentication errors

### CORS Issues

**Note**: This API is designed for server-to-server communication. WorkAdventure makes requests from its backend, not the browser. CORS shouldn't be an issue.

If testing from a browser directly, you may need to configure CORS in `next.config.ts`.

## Automated Testing Script

Save this as `test-api.sh`:

```bash
#!/bin/bash

TOKEN="${ADMIN_API_TOKEN:-dev-admin-api-token-change-in-production}"
BASE_URL="http://localhost:3000"

echo "🧪 Testing WorkAdventure Admin API"
echo "Token: ${TOKEN:0:20}..."
echo ""

test_endpoint() {
  local name=$1
  local method=$2
  local url=$3
  local data=$4
  
  echo "Testing: $name"
  
  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "$url")
  else
    response=$(curl -s -w "\n%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$data" "$url")
  fi
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
    echo "✅ $name: HTTP $http_code"
    echo "$body" | jq . 2>/dev/null || echo "$body"
  else
    echo "❌ $name: HTTP $http_code"
    echo "$body"
  fi
  echo ""
}

# Test endpoints
test_endpoint "Capabilities" "GET" "$BASE_URL/api/capabilities"

test_endpoint "Map" "GET" \
  "$BASE_URL/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room"

test_endpoint "Room Access" "GET" \
  "$BASE_URL/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1"

test_endpoint "Ban Check" "GET" \
  "$BASE_URL/api/ban?token=test-user&ipAddress=127.0.0.1&roomUrl=http://play.workadventure.localhost/@/universe/world/room"

echo "✅ Testing complete!"
```

Make it executable and run:
```bash
chmod +x test-api.sh
./test-api.sh
```

## Next Steps

- Read [Authentication](../AUTHENTICATION.md) for detailed auth info
- Check [Endpoints](../ENDPOINTS.md) for all available endpoints
- Review [Examples](../EXAMPLES.md) for implementation examples
- See [Integration Tests](./integration-tests.md) for automated testing

