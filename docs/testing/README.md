# Testing Guide

Complete guide for testing the WorkAdventure Admin API.

## Test Suites

### 1. Unit Tests (Jest)

Run unit tests for API routes and utilities:

```bash
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

**Test Files:**
- `__tests__/api/admin/universes.test.ts` - Universe API endpoints
- `__tests__/api/auth/login.test.ts` - Authentication endpoints
- `__tests__/lib/auth.test.ts` - Auth utilities

### 2. API Integration Tests (Shell Script)

Test actual API endpoints:

```bash
# Run API tests
npm run test:api

# Or directly
./scripts/test-api.sh
```

**Requirements:**
- Server must be running: `npm run dev`
- `ADMIN_API_TOKEN` must be set in environment or `.env.local`

**What it tests:**
- Capabilities endpoint
- Admin universes endpoints
- Admin worlds endpoints
- Admin rooms endpoints
- Admin users endpoints
- Auth endpoints

### 3. Integration Tests (Jest)

Test complete workflows with WorkAdventure + OIDC mock:

```bash
# Run integration tests
npm run test:integration

# Watch mode
npm run test:integration:watch
```

**Requirements:**
- WorkAdventure must be running (includes OIDC mock)
- Admin API server must be running
- Database must be accessible

**What it tests:**
- WorkAdventure → Admin API calls with real OIDC tokens
- Complete user workflows (login → create universe → access room)
- OIDC authentication flow
- Admin interface functionality

See [Integration Tests](./integration-tests.md) for detailed documentation.

### 4. Manual Testing

See [Manual Testing](./manual-testing.md) for manual testing procedures.

See [OIDC Authentication Testing](./oidc-authentication.md) for OIDC-specific testing.

## Running Tests

### Prerequisites

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your configuration
   ```

3. **Set up database:**
   ```bash
   docker-compose up -d postgres
   npx prisma generate
   npx prisma migrate dev
   ```

### Running All Tests

```bash
# 1. Start the server (in one terminal)
npm run dev

# 2. Run unit tests (in another terminal)
npm test

# 3. Run API integration tests
npm run test:api

# 4. Run integration tests (requires WorkAdventure running)
npm run test:integration
```

## Test Coverage

Current test coverage includes:

- ✅ Authentication (Bearer token validation)
- ✅ OIDC login flow
- ✅ Universe CRUD operations
- ✅ API endpoint responses
- ✅ Error handling
- ✅ WorkAdventure API integration
- ✅ Complete user workflows

## Adding New Tests

### Unit Test Example

```typescript
// __tests__/api/my-endpoint.test.ts
import { GET } from '@/app/api/my-endpoint/route';
import { NextRequest } from 'next/server';

describe('/api/my-endpoint', () => {
  it('should return data', async () => {
    const request = new NextRequest('http://localhost:3333/api/my-endpoint');
    const response = await GET(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data).toBeDefined();
  });
});
```

### Integration Test Example

```typescript
// __tests__/integration/my-workflow.test.ts
import { getOidcToken } from './helpers/oidc-mock';
import { callWorkAdventureAPI } from './helpers/workadventure-api';

describe('My Workflow', () => {
  it('should complete workflow', async () => {
    const token = await getOidcToken('User1', 'pwd');
    const response = await callWorkAdventureAPI('/api/map', {
      playUri: 'http://play.workadventure.localhost/@/universe/world/room',
      accessToken: token,
    });
    
    expect(response.status).toBe(200);
  });
});
```

### API Test Example

Add to `scripts/test-api.sh`:

```bash
test_endpoint "My Endpoint" "GET" "$BASE_URL/api/my-endpoint"
```

## Continuous Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm test
      - run: npm run test:api
      # Integration tests require WorkAdventure to be running
      # - run: npm run test:integration
```

## Troubleshooting

### Prisma Client Errors

If you see Prisma client errors:

```bash
# Regenerate Prisma client
npx prisma generate

# Reset database (WARNING: deletes all data)
npx prisma migrate reset
```

### Test Database

For tests, use a separate test database:

```env
# .env.test
DATABASE_URL=postgresql://user:pass@localhost:5432/test_db
```

### Mock Data

Tests use mocked Prisma clients. To test with real database:

1. Set up test database
2. Use test-specific environment variables
3. Clean up after tests

## Next Steps

- [x] Unit tests
- [x] API integration tests
- [x] Integration tests with WorkAdventure
- [ ] E2E tests with Playwright
- [ ] Performance tests
- [ ] Load tests

## Documentation

- [Manual Testing](./manual-testing.md) - Manual testing procedures
- [OIDC Authentication Testing](./oidc-authentication.md) - OIDC-specific testing
- [Integration Tests](./integration-tests.md) - Automated integration testing
- [Test Results](./test-results.md) - Current test status

