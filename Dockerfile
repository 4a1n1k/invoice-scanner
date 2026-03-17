# ─── Stage 1: Install deps ────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client for the target platform
RUN npx prisma generate

# Build Next.js (standalone output)
RUN npm run build

# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005
ENV HOSTNAME=0.0.0.0

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Persistent storage dir — mounted as a volume in docker-compose
RUN mkdir -p /app/storage/expenses \
 && chown -R nextjs:nodejs /app/storage

# Prisma schema (needed for migrations / db push at startup)
COPY --from=builder /app/prisma ./prisma

# Next.js standalone bundle
COPY --from=builder /app/public                    ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static

# Prisma client inside the standalone bundle
COPY --from=builder /app/node_modules/.prisma      ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma      ./node_modules/@prisma

USER nextjs
EXPOSE 3005

# Run DB migration then start the server
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
