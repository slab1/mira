#!/usr/bin/env fish
# Mira start script for fish shell
# Starts server, web UI, TUI UI, and optional Cloudflare tunnels
# Ports/hosts are env-overridable: MIRA_PORT, MIRA_WEB_PORT, MIRA_TUI_PORT, MIRA_HOST

set -x REPO_DIR (dirname (status filename | string replace scripts/start-mira.fish ""))
set -l SERVER_PORT (set -q MIRA_PORT; and echo $MIRA_PORT; or echo 4096)
set -l WEB_PORT (set -q MIRA_WEB_PORT; and echo $MIRA_WEB_PORT; or echo 3000)
set -l TUI_PORT (set -q MIRA_TUI_PORT; and echo $MIRA_TUI_PORT; or echo 3001)
set -l LOOPBACK (set -q MIRA_HOST; and echo $MIRA_HOST; or echo 127.0.0.1)
set -l LOG_DIR (set -q MIRA_LOG_DIR; and echo $MIRA_LOG_DIR; or echo /tmp)
set -x SERVER_LOG $LOG_DIR/mira-server.log
set -x WEB_LOG $LOG_DIR/mira-web.log
set -x TUI_LOG $LOG_DIR/mira-tui.log

function start_server
    echo "[mira] Starting server..."
    if pgrep -f "bun packages/server/src/index.ts" > /dev/null
        echo "[mira] server already running"
        return
    end
    nohup env PORT=$SERVER_PORT bun $REPO_DIR/packages/server/src/index.ts > $SERVER_LOG 2>&1 &
    echo $last_pid > $LOG_DIR/mira-server.pid
    sleep 3
    curl -s http://$LOOPBACK:$SERVER_PORT/healthz > /dev/null && echo "[mira] server up on http://$LOOPBACK:$SERVER_PORT" || echo "[mira] server start failed (see $SERVER_LOG)"
end

function start_web
    echo "[mira] Starting web UI..."
    if curl -s http://$LOOPBACK:$WEB_PORT > /dev/null
        echo "[mira] web already running"
        return
    end
    nohup env MIRA_WEB_PORT=$WEB_PORT bun run dev > $WEB_LOG 2>&1 &
    echo $last_pid > $LOG_DIR/mira-web.pid
    sleep 5
    curl -s http://$LOOPBACK:$WEB_PORT > /dev/null && echo "[mira] web up on http://$LOOPBACK:$WEB_PORT" || echo "[mira] web start failed (see $WEB_LOG)"
end

function start_tui
    echo "[mira] Starting TUI UI..."
    if curl -s http://$LOOPBACK:$TUI_PORT > /dev/null
        echo "[mira] tui already running"
        return
    end
    cd $REPO_DIR/packages/tui
    nohup env MIRA_TUI_PORT=$TUI_PORT bun run dev > $TUI_LOG 2>&1 &
    echo $last_pid > $LOG_DIR/mira-tui.pid
    sleep 5
    curl -s http://$LOOPBACK:$TUI_PORT > /dev/null && echo "[mira] tui up on http://$LOOPBACK:$TUI_PORT" || echo "[mira] tui start failed (see $TUI_LOG)"
end

start_server
sleep 2
start_web
start_tui

echo "[mira] All components started."
echo "Server: http://$LOOPBACK:$SERVER_PORT"
echo "Web:    http://$LOOPBACK:$WEB_PORT"
echo "TUI:    http://$LOOPBACK:$TUI_PORT"
