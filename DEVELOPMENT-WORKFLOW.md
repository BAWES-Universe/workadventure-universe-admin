# Complete Development Workflow

This document describes the complete automated development workflow for the WorkAdventure Admin API.

## Quick Start

### One-Command Setup

```bash
npm run setup
```

This will:
1. ✅ Check prerequisites (Node.js, npm, Docker)
2. ✅ Create/verify `.env.local` configuration
3. ✅ Install dependencies
4. ✅ Setup database (PostgreSQL)
5. ✅ Generate Prisma client
6. ✅ Run database migrations
7. ✅ Run unit tests
8. ✅ Verify server can start

### Manual Setup

If you prefer step-by-step:

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env.local
# Edit .env.local with your values

# 3. Start database
docker-compose up -d postgres

# 4. Generate Prisma client
npx prisma generate

# 5. Run migrations
npx prisma migrate dev

# 6. Start server
npm run dev
```

## Environment Variables

Required variables in `.env.local`:

```env
# Database
DATABASE_URL=postgresql://workadventure:workadventure@localhost:5432/workadventure_admin

# Admin API Token (must match WorkAdventure's ADMIN_API_TOKEN)
ADMIN_API_TOKEN=your-secret-token-here

# OIDC Configuration
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret

# Application
NODE_ENV=development
```

## Testing Workflow

### Run All Tests

```bash
npm run test:full
```

This runs:
- Unit tests (Jest)
- Linting (ESLint)
- Type checking (TypeScript)
- Prisma client verification

### Run Specific Tests

```bash
# Unit tests only
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# API integration tests (requires server running)
npm run test:api
```

### Test Workflow

1. **Start server** (Terminal 1):
   ```bash
   npm run dev
   ```

2. **Run tests** (Terminal 2):
   ```bash
   npm test
   npm run test:api
   ```

## Development Workflow

### 1. Make Changes

- Edit code in `app/`, `lib/`, etc.
- Tests will detect changes in watch mode

### 2. Run Tests

```bash
npm test
```

### 3. Check Types

```bash
npx tsc --noEmit
```

### 4. Lint Code

```bash
npm run lint
```

### 5. Test API Endpoints

```bash
# Start server
npm run dev

# In another terminal
npm run test:api
```

### 6. Test OIDC Authentication

See [TESTING-OIDC.md](./TESTING-OIDC.md) for detailed OIDC testing.

## Automated Validation

The project includes automated validation at multiple stages:

### Pre-commit (Recommended)

Create `.husky/pre-commit`:

```bash
#!/bin/sh
npm run test
npm run lint
npx tsc --noEmit
```

### CI/CD Pipeline

Example GitHub Actions workflow:

```yaml
name: CI

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
      - run: npm run setup
      - run: npm run test:full
```

## Troubleshooting

### Prisma Errors

```bash
# Fix Prisma client
npm run fix:prisma

# Or manually
npx prisma generate
```

### Database Issues

```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Or recreate
docker-compose down
docker-compose up -d postgres
npx prisma migrate dev
```

### Test Failures

```bash
# Clear Jest cache
npm test -- --clearCache

# Run with verbose output
npm test -- --verbose
```

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for more solutions.

## Complete Workflow Example

Here's a complete example of setting up and testing:

```bash
# 1. Clone and setup
git clone <repo>
cd workadventure-universe-admin
npm run setup

# 2. Verify everything works
npm run test:full

# 3. Start development
npm run dev

# 4. In another terminal, test API
npm run test:api

# 5. Access admin interface
# Open http://localhost:3000/admin
# Login with OIDC token from WorkAdventure
```

## Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run setup` | Complete automated setup and test |
| `npm test` | Run unit tests |
| `npm run test:full` | Run all tests (unit, lint, type check) |
| `npm run test:api` | Test API endpoints (requires server) |
| `npm run fix:prisma` | Fix Prisma client issues |
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run lint` | Run linter |

## Next Steps

- ✅ Setup complete
- ✅ Tests passing
- ✅ Server running
- 🚀 Ready for development!

See [ADMIN-GUIDE.md](./ADMIN-GUIDE.md) for using the admin interface.

