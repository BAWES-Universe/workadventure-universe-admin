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

# Accept NEXT_PUBLIC_PLAY_URL as build argument (with default fallback)
ARG NEXT_PUBLIC_PLAY_URL=http://play.workadventure.localhost
ENV NEXT_PUBLIC_PLAY_URL=$NEXT_PUBLIC_PLAY_URL

# DATABASE_URL is required during build for Prisma Client initialization
# Use a dummy value since we're not connecting to a database during build
RUN DATABASE_URL="postgresql://dummy:dummy@dummy:5432/dummy" npm run build

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
# Copy lib directory (needed for seed script imports)
COPY --from=builder /app/lib ./lib
# Copy config directory (needed for woka.json and companions.json validation)
COPY --from=builder /app/config ./config
# Copy built application
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# Copy startup script (optional - for automatic migrations)
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

EXPOSE 3333

# Default: start directly (migrations must be run manually or via post-deploy command)
# Use npm start to use local next from node_modules (not npx which downloads)
CMD ["npm", "start"]

# Alternative: Use startup script to run migrations automatically before starting
# Uncomment the line below and comment out the line above to enable automatic migrations
# CMD ["sh", "scripts/start.sh"]

