# Testing the API by hand

Moved from the main README. Other testing guides are in this folder: see the [Testing Guide](./README.md).

### Testing

#### Authentication Overview

This API uses **Bearer token authentication**. All requests must include the `ADMIN_API_TOKEN` in the Authorization header:

```
Authorization: Bearer {ADMIN_API_TOKEN}
```

**Important**: The `ADMIN_API_TOKEN` must match the token configured in your WorkAdventure instance. This is a shared secret between WorkAdventure and your Admin API.

#### Getting Your Token

1. **Check your `.env.local` file**:
   ```bash
   cat .env.local | grep ADMIN_API_TOKEN
   ```

2. **If not set, add it**:
   ```env
   ADMIN_API_TOKEN=your-secret-token-here-change-in-production
   ```

3. **Make sure WorkAdventure uses the same token**:
   - In WorkAdventure's environment variables, set:
     ```env
     ADMIN_API_TOKEN=your-secret-token-here-change-in-production
     ADMIN_API_URL=http://admin.bawes.localhost:8321
     ```

#### Testing with cURL

```bash
# Set your token as a variable (replace with your actual token)
export TOKEN="your-secret-token-here-change-in-production"
BASE_URL="http://admin.bawes.localhost:8321"

# Test capabilities endpoint
curl -H "Authorization: Bearer $TOKEN" \
  $BASE_URL/api/capabilities

# Test map endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room"

# Test room access endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1"

# Test without token (should return 401)
curl $BASE_URL/api/capabilities
```

#### Testing with Postman

1. **Create a new request**
2. **Set the URL**: `http://admin.bawes.localhost:8321/api/capabilities`
3. **Go to the "Authorization" tab**
4. **Select "Bearer Token" type**
5. **Enter your token**: `your-secret-token-here-change-in-production`
6. **Send the request**

You can also set the token in the Headers tab:
- Key: `Authorization`
- Value: `Bearer your-secret-token-here-change-in-production`

#### Testing with WorkAdventure Integration

1. **Ensure WorkAdventure is configured**:
   ```env
   ADMIN_API_URL=http://admin.bawes.localhost
   ADMIN_API_TOKEN=your-secret-token-here-change-in-production
   ```
   
   **Note**: Since both services run behind Traefik, WorkAdventure can access the Admin API via the domain name if both are on the same network, or via the Traefik port if needed.

2. **Start WorkAdventure** (if not already running)

3. **Access a room** in WorkAdventure:
   - Open `http://play.workadventure.localhost/@/universe/world/room`
   - WorkAdventure will automatically call your Admin API endpoints

4. **Check your API logs** to see incoming requests:
   ```bash
   # View logs from Docker
   docker-compose logs -f admin-api
   
   # Or if running on host, your Next.js dev server will show logs like:
   # GET /api/map 200 in 45ms
   # GET /api/room/access 200 in 23ms
   ```

#### Quick Test Script

Create a test script to verify all endpoints:

```bash
#!/bin/bash
# test-api.sh

TOKEN="${ADMIN_API_TOKEN:-your-secret-token-here-change-in-production}"
BASE_URL="http://admin.bawes.localhost:8321"

echo "Testing Admin API with token: $TOKEN"
echo ""

# Test capabilities
echo "1. Testing /api/capabilities..."
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/capabilities" | jq .
echo ""

# Test map (adjust playUri as needed)
echo "2. Testing /api/map..."
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room" | jq .
echo ""

# Test room access
echo "3. Testing /api/room/access..."
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1" | jq .
echo ""

echo "Done!"
```

Save as `test-api.sh`, make it executable (`chmod +x test-api.sh`), and run it.

#### Common Issues

**401 Unauthorized**:
- Check that `ADMIN_API_TOKEN` is set in `.env.local`
- Verify the token in the Authorization header matches exactly
- Ensure there are no extra spaces in the token

**Connection Refused**:
- Make sure services are running: `docker-compose ps`
- Check the API is accessible at `http://admin.bawes.localhost:8321`
- Verify hosts file is configured correctly (see Setup step 1)
- Check Traefik is running: `docker-compose logs traefik`

**Token Mismatch with WorkAdventure**:
- Ensure both WorkAdventure and Admin API use the same `ADMIN_API_TOKEN`
- Restart both services after changing the token
