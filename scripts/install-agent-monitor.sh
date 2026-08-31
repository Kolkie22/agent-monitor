#!/bin/bash
# install-agent-monitor.sh — 安装 com.dsh.agent-monitor LaunchAgent（开机自启 + KeepAlive）
# 用法: bash scripts/install-agent-monitor.sh
set -euo pipefail

HARNESS="${HARNESS:-/Users/kolkie/harness}"
SRC="$HARNESS/scripts/com.dsh.agent-monitor.plist"
DEST="$HOME/Library/LaunchAgents/com.dsh.agent-monitor.plist"
DOMAIN="gui/$(id -u)"
LABEL="com.dsh.agent-monitor"

echo "==> 安装 plist 到 $DEST"
cp "$SRC" "$DEST"

echo "==> 加载/重载 launchd 服务 $DOMAIN/$LABEL"
# 已加载则先卸载，避免重复
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
  sleep 1
fi
launchctl bootstrap "$DOMAIN" "$DEST" 2>/dev/null || launchctl load "$DEST"

echo "==> 等待服务就绪"
for i in $(seq 1 15); do
  if curl -sf -m 2 http://127.0.0.1:8899/api/agents >/dev/null 2>&1; then
    echo "OK: http://127.0.0.1:8899 已就绪（第 ${i}s）"
    break
  fi
  sleep 1
done

echo "==> 打开仪表盘"
open http://127.0.0.1:8899 2>/dev/null || true

echo "==> 完成。写操作 Token 在 $HARNESS/.dsh-home/agent-monitor.json"
echo "==> 状态检查: launchctl print $DOMAIN/$LABEL"