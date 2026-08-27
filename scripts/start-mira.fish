#!/usr/bin/env fish
# Mira start script for fish shell
# Starts server, web UI, TUI UI, and optional Cloudflare tunnels

set -x REPO_DIR (dirname (status filename | string replace scripts/start-mira.fish ""))
set -x SERVER_LOG /tmp/mira-server.log
set -x WEB_LOG /tmp/mira-web.log
set -x TUI_LOG /tmp/mira-tui.log

function start_server
    echo "[mira] Starting server..."
    if pgrep -f "bun packages/server/src/index.ts" > /dev/null
        echo "[mira] server already running"
        return
    end
    nohup bun $REPO_DIR/packages/server/src/index.ts > $SERVER_LOG 2>&1 &
    echo $last_pid > /tmp/mira-server.pid
    sleep 3
    curl -s http://127.0.0.1:4096/healthz > /dev/null && echo "[mira] server up on http://127.0.0.1:4096" || echo "[mira] server start failed"
end

function start_web
    echo "[mira] Starting web UI..."
    if curl -s http://127.0.0.1:3000 > /dev/null
        echo "[mira] web already running"
        return
    end
    nohup bun run dev > $WEB_LOG 2>&1 & 
    echo $last_pid > /tmp/mira-web.pid
    sleep 5
    curl -s http://127.0.0.1:3000 > /dev/null && echo "[mira] web up on http://127.0.0.1:3000" || echo "[mira] web start failed"
end

function start_tui
    echo "[mira] Starting TUI UI..."
    if curl -s http://localhost:3001 > /dev/null
        echo "[mira] tui already running"
        return
    end
    cd $REPO_DIR/packages/tui
    nohup bun run dev > $TUI_LOG 2>&1 &
    echo $last_pid > /tmp/mira-tui.pid
    sleep 5
    curl -s http://localhost:3001 > /dev/null && echo "[mira] tui up on http://localhost:3001" || echo "[mira] tui start failed"
end

start_server
sleep 2
start_web
start_tui

echo "[mira] All components started."
echo "Server: http://127.0.0.1:4096"
echo "Web:    http://127.0.0.1:3000"
echo "TUI:    http://localhost:3001"
