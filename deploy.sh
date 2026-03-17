#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Pull latest code and redeploy the invoice-scanner container
#
# Usage (on the server):
#   chmod +x deploy.sh
#   ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

APP_DIR="/opt/invoice-scanner"
REPO_URL="https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/' 2>/dev/null || echo 'OWNER/invoice-scanner')"

echo "──────────────────────────────────────"
echo "  Invoice Scanner — Deploy Script"
echo "──────────────────────────────────────"

# ── 1. Check port availability ────────────────────────────────────────────────
PORT=3005
if ss -tlnp | grep -q ":${PORT} " ; then
  OWNER=$(ss -tlnp | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | xargs -I{} ps -p {} -o comm= 2>/dev/null || echo "unknown")
  # Check if it's our own container
  if docker ps --format '{{.Names}}' | grep -q 'invoice-scanner'; then
    echo "✅ Port ${PORT} already used by our container — will redeploy"
  else
    echo "⚠️  Port ${PORT} is in use by: ${OWNER}"
    echo "   Edit docker-compose.yml to use a different host port, or stop the conflicting service."
    exit 1
  fi
else
  echo "✅ Port ${PORT} is free"
fi

# ── 2. Create app directory ───────────────────────────────────────────────────
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

# ── 3. Clone or pull ──────────────────────────────────────────────────────────
if [ -d ".git" ]; then
  echo "📥 Pulling latest changes..."
  git pull origin main
else
  echo "📥 Cloning repository..."
  git clone "${REPO_URL}" .
fi

# ── 4. Ensure .env exists ─────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp .env.production.example .env
    echo "⚠️  Created .env from example — EDIT IT NOW before continuing!"
    echo "   nano ${APP_DIR}/.env"
    exit 1
  else
    echo "❌ No .env file found. Create one before deploying."
    exit 1
  fi
fi

# ── 5. Build & deploy ─────────────────────────────────────────────────────────
echo "🏗️  Building Docker image..."
docker compose build --no-cache

echo "🚀 Starting container..."
docker compose up -d

echo ""
echo "──────────────────────────────────────"
echo "✅ Deployed! Invoice Scanner running at:"
echo "   http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP'):${PORT}"
echo ""
echo "📋 Useful commands:"
echo "   docker compose logs -f invoice-scanner   # live logs"
echo "   docker compose ps                        # status"
echo "   docker compose down                      # stop"
echo "──────────────────────────────────────"
