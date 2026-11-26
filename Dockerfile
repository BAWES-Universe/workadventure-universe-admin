# Production Dockerfile for Admin API
# Multi-stage build for smaller image size

# Stage 1: Dependencies
FROM node:20.19-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Stage 2: Build
FROM node:20.19-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY prisma/ ./prisma/
COPY prisma.config.ts ./
# Generate Prisma Client
# Prisma v7: schema.prisma no longer has url field, datasource URL is in prisma.config.ts
# prisma generate doesn't need DATABASE_URL - it only reads the schema file
# Temporarily rename config file since it requires DATABASE_URL, but generate doesn't need it
RUN mv prisma.config.ts prisma.config.ts.bak && \
    npx prisma generate --schema=prisma/schema.prisma && \
    mv prisma.config.ts.bak prisma.config.ts
COPY . .
# Remove next-env.d.ts if it exists (auto-generated, may have permission issues)
RUN rm -f next-env.d.ts || true

# next build (the TypeScript step in particular) can run out of Node's default heap and crash
# with "JavaScript heap out of memory" on a big build. Give the build 4 GB of heap. This is a
# ceiling, not a reservation, and it only applies to this builder stage, not the runtime image.
ENV NODE_OPTIONS=--max-old-space-size=4096

# Production builds must provide the exact WorkAdventure play origin.
ARG NEXT_PUBLIC_PLAY_URL
ENV NEXT_PUBLIC_PLAY_URL=$NEXT_PUBLIC_PLAY_URL

# Optional browser Sentry settings, passed only by dev-server builds. When empty they are
# unset before the build, so a build without them produces the same bundle as before.
ARG NEXT_PUBLIC_SENTRY_DSN_ADMIN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT

# DATABASE_URL is required during build for Prisma Client initialization
# Use a dummy value since we're not connecting to a database during build
RUN [ -n "$NEXT_PUBLIC_SENTRY_DSN_ADMIN" ] || unset NEXT_PUBLIC_SENTRY_DSN_ADMIN; \
    [ -n "$NEXT_PUBLIC_SENTRY_ENVIRONMENT" ] || unset NEXT_PUBLIC_SENTRY_ENVIRONMENT; \
    DATABASE_URL="postgresql://dummy:dummy@dummy:5432/dummy" npm run build

# Stage 3: Runtime
FROM node:20.19-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3333

# Copy production dependencies (includes next and @prisma/client)
COPY --from=deps /app/node_modules ./node_modules
# Copy Next.js from builder (ensure correct version matches build)
COPY --from=builder /app/node_modules/next ./node_modules/next
# Copy Prisma generated client files from builder (needed for @prisma/client to work)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Copy @prisma/client from builder (has generated client integrated)
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Copy prisma from builder (needed for prisma.config.ts)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# Copy package.json before npm install
COPY --from=builder /app/package.json ./package.json
# Install tsx (needs esbuild and other deps, so use npm install to resolve dependencies)
RUN npm install tsx@^4.19.2
# Copy dotenv after npm install (npm install might remove it, so restore it)
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv
# Copy Prisma schema and migrations
COPY --from=builder /app/prisma ./prisma
# Copy package.json
COPY --from=builder /app/package.json ./package.json
# Copy seed file and prisma.config.ts for seeding
COPY --from=builder /app/prisma/seed.ts ./prisma/seed.ts
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# The start script applies migrations with this CLI. prisma is a devDependency, copied in from the builder
# and kept through the tsx install above: fail the BUILD here if it (or its config) cannot load, rather
# than shipping an image that refuses to start. No database is reached: --version only loads the config.
RUN DATABASE_URL="postgresql://build:check@localhost:5432/none" node node_modules/prisma/build/index.js --version
# Copy lib directory (needed for seed script imports)
COPY --from=builder /app/lib ./lib
# Copy config directory (needed for woka.json and companions.json validation)
COPY --from=builder /app/config ./config
# Copy built application
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# The start script: applies the database migrations, then starts the app (see CMD below)
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

EXPOSE 3333

# Apply every pending database migration, then start the app (npm start, which runs the local next).
# If the migrations do not all apply, the script exits non-zero and the app never starts, so this
# image never serves on a database it was not written for. See scripts/start.sh.
CMD ["sh", "scripts/start.sh"]
