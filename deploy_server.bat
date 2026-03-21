@echo off
ssh -F nul -p 2299 root@116.203.149.15 "cd /opt/invoice-scanner && git pull origin main && docker compose down && docker compose build --no-cache && docker compose up -d && sleep 3 && curl -s http://localhost:3005/api/health"
