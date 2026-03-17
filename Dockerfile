# ─── Stage 1: Install deps ────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node_modules/.bin/prisma generate
RUN npm run build

# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

RUN mkdir -p /app/storage/expenses \
 && chown -R nextjs:nodejs /app/storage

COPY --from=builder /app/prisma                                    ./prisma
COPY --from=builder /app/public                                    ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone    ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static        ./.next/static
COPY --from=builder /app/node_modules/.prisma                      ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma                      ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma                       ./node_modules/prisma

USER nextjs
EXPOSE 3005

# Use the local prisma binary (v5) — not the global one on the host
CMD ["sh", "-c", "node_modules/.bin/prisma db push && node server.js"]
