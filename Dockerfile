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

RUN npx prisma generate
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

# Prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma  ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma   ./node_modules/prisma

# Dynamic-require packages not bundled by Next.js standalone
COPY --from=builder /app/node_modules/pdf-parse  ./node_modules/pdf-parse
COPY --from=builder /app/node_modules/adm-zip    ./node_modules/adm-zip

# Next.js standalone bundle
COPY --from=builder /app/public                                        ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone        ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static            ./.next/static

# Startup script
COPY --chown=nextjs:nodejs start.sh ./start.sh
RUN chmod +x ./start.sh

USER nextjs
EXPOSE 3005

CMD ["./start.sh"]
