# Troubleshooting Guide

## Prisma Client Error: "engine type 'client' requires either 'adapter' or 'accelerateUrl'"

### Solution 1: Regenerate Prisma Client

```bash
# Regenerate Prisma client
npx prisma generate

# Or use the fix script
npm run fix:prisma
```

### Solution 2: Check Node.js Version

Prisma 7.x requires Node.js 20.19+ or 22.12+:

```bash
node --version  # Should be >= 20.19 or >= 22.12
```

If your version is too old:
- Update Node.js: `nvm install 20.19` or `nvm install 22.12`
- Or downgrade Prisma: `npm install prisma@6 @prisma/client@6`

### Solution 3: Verify DATABASE_URL

Ensure `DATABASE_URL` is set in `.env.local`:

```bash
# Check if set
grep DATABASE_URL .env.local

# Should be something like:
# DATABASE_URL=postgresql://user:password@localhost:5432/workadventure
```

### Solution 4: Clean Install

If issues persist:

```bash
# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Regenerate Prisma client
npx prisma generate
```

### Solution 5: Check Prisma Schema

Ensure your `prisma/schema.prisma` has:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

## Running Tests

### Unit Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

### API Integration Tests

```bash
# Start server first (in one terminal)
npm run dev

# Run API tests (in another terminal)
npm run test:api
```

### Fix Common Test Issues

**Issue: Prisma client not found in tests**

```bash
# Regenerate Prisma client
npx prisma generate
```

**Issue: Database connection errors in tests**

Tests use mocked Prisma, so no database needed. If you see connection errors:
- Check that mocks are properly set up
- Verify test environment variables

## Common Issues

### 1. "DATABASE_URL environment variable is not set"

**Solution:**
```bash
# Create .env.local if it doesn't exist
cp .env.example .env.local

# Add DATABASE_URL
echo "DATABASE_URL=postgresql://user:password@localhost:5432/workadventure" >> .env.local
```

### 2. "Unauthorized" errors in API tests

**Solution:**
```bash
# Set ADMIN_API_TOKEN
export ADMIN_API_TOKEN=your-token-here

# Or add to .env.local
echo "ADMIN_API_TOKEN=your-token-here" >> .env.local
```

### 3. OIDC validation fails

**Solution:**
- Check `OIDC_ISSUER` is accessible
- Verify OIDC mock is running (if using dev)
- Check `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`

### 4. Tests timeout

**Solution:**
- Increase Jest timeout in `jest.config.js`:
  ```js
  testTimeout: 10000
  ```

## Getting Help

1. Check logs: Look at console output for detailed error messages
2. Verify environment: Ensure all required env vars are set
3. Check versions: Node.js, Prisma, Next.js compatibility
4. Review documentation: See README.md and other docs

