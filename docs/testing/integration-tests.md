# Integration Tests

Complete guide for integration tests that require WorkAdventure + OIDC mock to be running.

## Overview

Integration tests simulate real WorkAdventure → Admin API interactions using actual OIDC tokens from the WorkAdventure OIDC mock server. These tests verify the complete flow from authentication through API calls to admin interface usage.

## Prerequisites

### Required Services

1. **WorkAdventure** (includes OIDC mock):
   ```bash
   cd workadventure
   docker-compose up
   ```

2. **Admin API Server**:
   ```bash
   npm run dev
   ```

3. **Database**:
   ```bash
   docker-compose up -d postgres
   ```

### Environment Variables

Ensure these are set in `.env.local`:

```env
# Database
DATABASE_URL=postgresql://workadventure:workadventure@localhost:5432/workadventure_admin

# Admin API Token (must match WorkAdventure's ADMIN_API_TOKEN)
ADMIN_API_TOKEN=your-secret-token-here

# OIDC Configuration
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret

# Admin API URL (for tests)
ADMIN_API_URL=http://localhost:3333
```

## Running Integration Tests

### Quick Start

```bash
# 1. Start WorkAdventure (Terminal 1)
cd workadventure
docker-compose up

# 2. Start Admin API (Terminal 2)
npm run dev

# 3. Run integration tests (Terminal 3)
npm run test:integration
```

### Watch Mode

```bash
npm run test:integration:watch
```

## Test Structure

### Test Files

- `__tests__/integration/workadventure-api-flow.test.ts` - Tests WorkAdventure → Admin API calls
- `__tests__/integration/oidc-authentication-flow.test.ts` - Tests OIDC authentication
- `__tests__/integration/user-workflow.test.ts` - Tests complete user workflows
- `__tests__/integration/admin-interface-flow.test.ts` - Tests admin interface

### Test Helpers

- `__tests__/integration/helpers/oidc-mock.ts` - OIDC token fetching
- `__tests__/integration/helpers/workadventure-api.ts` - Simulate WorkAdventure API calls
- `__tests__/integration/helpers/database.ts` - Database utilities
- `__tests__/integration/helpers/auth.ts` - Authentication helpers

## Test Scenarios

### WorkAdventure API Flow

Tests simulate WorkAdventure making API calls:

1. **Capabilities Check**:
   - WorkAdventure calls `/api/capabilities` on startup
   - Verifies Bearer token authentication
   - Checks response format

2. **Map Resolution**:
   - WorkAdventure calls `/api/map` with `playUri`
   - Optionally includes `accessToken` for authenticated users
   - Verifies map details are returned

3. **Room Access**:
   - WorkAdventure calls `/api/room/access` with user info
   - Includes `accessToken` for authenticated users
   - Verifies user permissions and access

4. **Member Search**:
   - WorkAdventure calls `/api/members` for user directory
   - Tests search functionality
   - Verifies response format

### OIDC Authentication Flow

Tests the complete OIDC authentication:

1. **Get OIDC Token**:
   - Authenticate with OIDC mock (User1/pwd)
   - Obtain access token
   - Verify token is valid

2. **Login to Admin Interface**:
   - Use OIDC token to login
   - Verify session creation
   - Check user data is stored

3. **Token Validation**:
   - Verify token validation works
   - Test expired tokens
   - Test invalid tokens

### User Workflow

Tests complete user workflows:

1. **Create Universe**:
   - Login with OIDC token
   - Create universe via admin API
   - Verify universe is created

2. **Create World**:
   - Create world in universe
   - Set map URL
   - Verify world is accessible

3. **Create Room**:
   - Create room in world
   - Verify room is accessible

4. **Access Room via WorkAdventure API**:
   - Call `/api/map` with playUri
   - Call `/api/room/access` with user info
   - Verify user can access room

5. **User Isolation**:
   - Create content as User1
   - Login as User2
   - Verify User2 cannot see User1's content

### Admin Interface Flow

Tests admin interface functionality:

1. **Login**:
   - Login with OIDC token
   - Verify dashboard loads
   - Check user info is displayed

2. **Create Operations**:
   - Create universe
   - Create world
   - Create room
   - Verify all are visible

3. **Edit Operations**:
   - Edit universe
   - Edit world
   - Edit room
   - Verify changes are saved

4. **Delete Operations**:
   - Delete room
   - Delete world
   - Delete universe
   - Verify deletion works

## Writing Integration Tests

### Example: Testing WorkAdventure API Call

```typescript
import { getOidcToken } from './helpers/oidc-mock';
import { callWorkAdventureAPI } from './helpers/workadventure-api';

describe('WorkAdventure API Flow', () => {
  it('should handle map request with OIDC token', async () => {
    // Get OIDC token from WorkAdventure mock
    const token = await getOidcToken('User1', 'pwd');
    
    // Simulate WorkAdventure calling Admin API
    const response = await callWorkAdventureAPI('/api/map', {
      playUri: 'http://play.workadventure.localhost/@/universe/world/room',
      accessToken: token,
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.mapUrl).toBeDefined();
  });
});
```

### Example: Testing User Workflow

```typescript
import { getOidcToken } from './helpers/oidc-mock';
import { loginToAdmin } from './helpers/auth';
import { createUniverse } from './helpers/database';

describe('User Workflow', () => {
  it('should create universe and access room', async () => {
    // 1. Get OIDC token
    const token = await getOidcToken('User1', 'pwd');
    
    // 2. Login to admin interface
    const session = await loginToAdmin(token);
    expect(session.user).toBeDefined();
    
    // 3. Create universe
    const universe = await createUniverse({
      slug: 'test-universe',
      name: 'Test Universe',
      ownerId: session.user.id,
    });
    
    // 4. Access room via WorkAdventure API
    const mapResponse = await callWorkAdventureAPI('/api/map', {
      playUri: `http://play.workadventure.localhost/@/${universe.slug}/world/room`,
      accessToken: token,
    });
    
    expect(mapResponse.status).toBe(200);
  });
});
```

## Test Helpers

### OIDC Mock Helper

```typescript
// Get OIDC token from WorkAdventure mock
const token = await getOidcToken('User1', 'pwd');
```

### WorkAdventure API Helper

```typescript
// Simulate WorkAdventure API call
const response = await callWorkAdventureAPI('/api/map', {
  playUri: 'http://play.workadventure.localhost/@/universe/world/room',
  accessToken: token,
});
```

### Database Helper

```typescript
// Clean database before test
await cleanDatabase();

// Seed test data
await seedTestData();
```

## Troubleshooting

### "WorkAdventure not running"

**Solution**:
```bash
# Check if WorkAdventure is running
docker ps | grep workadventure

# Start WorkAdventure
cd workadventure
docker-compose up
```

### "OIDC mock not accessible"

**Solution**:
```bash
# Verify OIDC mock is accessible
curl http://oidc.workadventure.localhost/.well-known/openid-configuration

# Check Traefik routing
curl -H "Host: oidc.workadventure.localhost" http://localhost/.well-known/openid-configuration
```

### "Database connection failed"

**Solution**:
```bash
# Check database is running
docker ps | grep postgres

# Verify connection
psql $DATABASE_URL
```

### "Tests timeout"

**Solution**:
- Increase Jest timeout in `jest.config.js`
- Check network connectivity
- Verify all services are responding

## Best Practices

1. **Clean State**: Always clean database between tests
2. **Isolation**: Each test should be independent
3. **Real Tokens**: Use real OIDC tokens from mock, not mocks
4. **Error Handling**: Test both success and error cases
5. **Documentation**: Document test scenarios clearly

## CI/CD Considerations

Integration tests require WorkAdventure to be running. For CI/CD:

1. **Start WorkAdventure**: Use docker-compose in CI
2. **Wait for Services**: Add health checks before running tests
3. **Cleanup**: Ensure proper cleanup after tests
4. **Separate Jobs**: Consider separate job for integration tests

Example GitHub Actions:

```yaml
jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Start WorkAdventure
        run: |
          cd workadventure
          docker-compose up -d
      - name: Wait for services
        run: |
          ./scripts/wait-for-services.sh
      - name: Run integration tests
        run: npm run test:integration
```

## Next Steps

- Add more test scenarios
- Add performance tests
- Add load tests
- Add E2E tests with Playwright

