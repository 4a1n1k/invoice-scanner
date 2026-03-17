@echo off
setlocal enabledelayedexpansion
cd /d D:\Projects\Antigravity\invoice-scanner

echo.
echo ============================================
echo  STEP 1: Git commit and push to GitHub
echo ============================================
echo.

:: Configure remote
git remote remove origin 2>nul
git remote add origin https://github.com/4a1n1k/invoice-scanner.git

:: Stage everything
git add -A

:: Commit
git commit -m "feat: full arch refactor - env config, type safety, docker, improved LLM prompt, Hebrew PDF"

:: Push
git branch -M main
git push -u origin main

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Git push failed. Check credentials.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  STEP 2: Deploy to server via SSH
echo ============================================
echo.

:: Create deploy commands file
set DEPLOY_SCRIPT=/tmp/deploy_invoice.sh
set SERVER=root@116.203.149.15
set PORT=2299

:: Write the remote script inline via ssh
ssh -o StrictHostKeyChecking=no -p %PORT% %SERVER% "bash -s" << 'ENDSSH'
set -e
echo "--- Checking port 3005 ---"
if ss -tlnp | grep -q ':3005 '; then
  echo "Port 3005 status:"
  ss -tlnp | grep ':3005'
else
  echo "Port 3005 is FREE"
fi

echo ""
echo "--- Running Docker containers ---"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null || echo "Docker not available or no containers"

echo ""
echo "--- Setting up invoice-scanner ---"
mkdir -p /opt/invoice-scanner
cd /opt/invoice-scanner

if [ -d ".git" ]; then
  echo "Pulling latest..."
  git pull origin main
else
  echo "Cloning..."
  git clone https://github.com/4a1n1k/invoice-scanner.git .
fi

echo ""
echo "--- Checking .env ---"
if [ ! -f ".env" ]; then
  cp .env.production.example .env
  # Set a real secret
  SECRET=$(openssl rand -base64 32)
  sed -i "s/REPLACE_WITH_STRONG_SECRET/$SECRET/" .env
  echo "Created .env with generated secret"
fi

cat .env

echo ""
echo "--- Building Docker image ---"
docker compose build

echo ""
echo "--- Starting container ---"
docker compose up -d

echo ""
echo "--- Container status ---"
docker compose ps

echo ""
echo "--- Health check ---"
sleep 5
curl -s http://localhost:3005/api/health || echo "Health check pending..."

echo ""
echo "=== DONE ==="
ENDSSH

echo.
echo ============================================
echo  ALL DONE
echo ============================================
pause
