# Orbit

Orbit is the admin app for [Universe](https://github.com/BAWES-Universe/workadventure-universe), the shared online world built on WorkAdventure. It is a Next.js app, and it is also the Admin API that WorkAdventure calls for user management, room access control and moderation features. This repository is `workadventure-universe-admin`.

- **Release history:** [CHANGELOG.md](./CHANGELOG.md) (the README never carries version numbers)
- **Latest release:** [GitHub releases](https://github.com/BAWES-Universe/workadventure-universe-admin/releases)

## Overview

This Admin API integrates with WorkAdventure to provide:
- User authentication and authorization via OIDC
- Room and world access control
- Member management
- Woka (avatar) and companion management
- Ban and moderation features
- Chat member directory

On top of the Admin API, Orbit is where people run their part of Universe:
- Universes, worlds, rooms, members and invitations
- Bricks (AI bots): their look, Mind, voice, behavior and permissions
- Apps: connect an App once and choose which Bricks use it, lend an App to a universe
- Goals and tasks: reminders, watches, briefings and what Bricks did
- Usage: what Bricks use, by person and by Brick

## Quick start

You need Node.js 18+, Docker and Docker Compose, and a WorkAdventure instance (its OIDC mock is used in development).

1. Add `admin.bawes.localhost` and `traefik-admin.bawes.localhost` to your hosts file (see [Getting started](./docs/development/getting-started.md) for how).
2. Install and configure:
   ```bash
   npm install
   cp .env.example .env   # fill in ADMIN_API_TOKEN, OIDC_ISSUER and the DB_* values
   ```
3. Start everything and set up the database:
   ```bash
   docker-compose up
   docker compose exec admin-api npx prisma migrate deploy
   docker compose exec admin-api npx prisma db seed   # optional, recommended
   ```

Orbit is then at http://admin.bawes.localhost:8321 (port `8321` is Traefik's, set by `TRAEFIK_PORT` in `.env`). Point WorkAdventure at it with `ADMIN_API_URL=http://host.docker.internal:8321` and the same `ADMIN_API_TOKEN`.

The full steps, environment variables, database commands and Docker setup are in [docs/development/getting-started.md](./docs/development/getting-started.md).

## Documentation

### Core Documentation
- [Setup Guide](./docs/SETUP.md) - Complete setup guide
- [API Endpoints](./docs/ENDPOINTS.md) - API endpoint reference
- [Database Schema](./docs/DATABASE.md) - Database schema documentation
- [Authentication](./docs/AUTHENTICATION.md) - Authentication guide
- [Data Types](./docs/DATA-TYPES.md) - Type definitions
- [Examples](./docs/EXAMPLES.md) - Code examples

### Development
- [Getting started locally](./docs/development/getting-started.md) - Full setup, environment variables, database commands and Docker
- [Project structure and API overview](./docs/development/overview.md) - Folder layout and endpoint list
- [Development Workflow](./docs/development/workflow.md) - Complete automated development workflow
- [Troubleshooting](./docs/development/troubleshooting.md) - Common issues and solutions

### Testing
- [Testing Guide](./docs/testing/README.md) - Complete testing documentation
- [Testing the API by hand](./docs/testing/api-testing.md) - cURL, Postman and a quick test script
- [Manual Testing](./docs/testing/manual-testing.md) - Manual testing procedures
- [OIDC Authentication Testing](./docs/testing/oidc-authentication.md) - OIDC-specific testing
- [Integration Tests](./docs/testing/integration-tests.md) - Automated integration testing with WorkAdventure

### Admin Interface
- [Admin Interface Guide](./docs/admin/guide.md) - Complete admin interface documentation

## Deployment

See [docs/SETUP.md](./docs/SETUP.md#production-deployment) for deployment instructions.
