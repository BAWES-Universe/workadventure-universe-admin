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
# Generate Prisma Client (temporarily rename config file since it requires DATABASE_URL during build)
# prisma generate doesn't need DATABASE_URL - it only reads the schema file
RUN mv prisma.config.ts prisma.config.ts.bak && \
    npx prisma generate --schema=prisma/schema.prisma && \
    mv prisma.config.ts.bak prisma.config.ts
COPY . .
# DATABASE_URL is required during build for Prisma Client initialization
# Use a dummy value since we're not connecting to a database during build
RUN DATABASE_URL="postgresql://dummy:dummy@dummy:5432/dummy" npm run build

# Stage 3: Runtime
FROM node:20.19-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3333

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules
# Copy Prisma files and generated client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Copy built application
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
# Copy startup script (optional - for automatic migrations)
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

EXPOSE 3333

# Default: start directly (migrations must be run manually or via post-deploy command)
# Use npx to ensure next is found even if PATH isn't set correctly
CMD ["npx", "next", "start"]

# Alternative: Use startup script to run migrations automatically before starting
# Uncomment the line below and comment out the line above to enable automatic migrations
# CMD ["sh", "scripts/start.sh"]

