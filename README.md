# Agent Monitor — 本机 AI Agent 状态监控台

实时监控本机 Mac 上各 AI agent（OpenClaw / Hermes / cc-connect / DSH·Lark / DSH·微信桥 / Ollama / WorkBuddy）的运行状态：状态色点、PID/端口、存活时长、最后活动、日志尾流、24h 时间线、一键重启。

- 采集：launchctl + 端口 + 状态文件 + 日志活性，4 类只读探针，每 5s 轮询，三重交叉验证防误报
- 服务：零依赖 Node，REST + SSE 实时推送，写操作（重启/启停）Token 门控
- 前端：单文件 HTML，无构建
- 安全：默认只绑定 127.0.0.1；日志尾流自动掩码密钥

## 快速开始（本机）

```bash
# 直接运行
node scripts/agent-monitor.mjs
# 浏览器打开
open http://127.0.0.1:8899

# 或安装为 LaunchAgent（开机自启 + KeepAlive）
bash scripts/install-agent-monitor.sh
```

写操作 Token 首次运行自动生成于 `~/.dsh-home/agent-monitor.json`（若 DSH_HOME 已设置则在其下），仪表盘右上角输入后可用重启/启停。

重启监控服务：`launchctl kickstart -k gui/$(id -u)/com.dsh.agent-monitor`

## 远程访问（两种方式）

### 1. GitHub Pages 云端快照（本项目仓库，默认推荐）

本仓库已启用 GitHub Pages：https://Kolkie22.github.io/agent-monitor/
页面打开后自动进入 **云端快照模式**，显示的是**真实状态**（不再是演示数据）：

- 本机常驻的 agent-monitor 进程每 **10 分钟**执行 `scripts/publish-gh-pages.mjs`：
  抓取最新 `/api/agents` + `/api/system` → 写入仓库根 `status.json` → 有变化才 `git push`（GitHub Pages 自动重建）
- 页面每 **30s** 自动拉取最新快照：优先 `raw.githubusercontent.com` 直读（数据更新不用等 Pages 重建），同源 `status.json` 兜底
- 顶部横幅显示「最后快照」时间，可点「立即刷新」
- 注意：GitHub Pages 每小时构建有软上限（约 10 次），10 分钟节奏安全；本机离线或监控服务停止时页面保留上一次快照

### 2. 实时隧道（看到本机实时数据）

本机起着监控服务时，带 `?api=` 打开页面可直连本机数据（SSE 实时刷新）：

```bash
# localtunnel（走 443，最稳）
npx -y localtunnel --port 8899
# 然后访问：https://kolkie22.github.io/agent-monitor/?api=https://<tunnel>.loca.lt
```

> ⚠️ 公网暴露说明：隧道把本机监控页公开到互联网，读取接口无鉴权（日志尾部可能含敏感信息），写操作有 Token 保护。建议设 Cloudflare Access 认证，或仅在需要时临时启动隧道。

## API

| 端点 | 方法 | 说明 |
| ---- | ---- | ---- |
| `/api/agents` | GET | 全量快照 |
| `/api/agents/:id` | GET | 详情 + 历史 |
| `/api/agents/:id/log` | GET | 日志尾流（掩码后） |
| `/api/agents/:id/history` | GET | 24h 时间线 |
| `/api/agents/:id/restart\|start\|stop` | POST | 写操作（需 Bearer Token） |
| `/api/system` | GET | CPU/内存/磁盘 |
| `/events` | GET | SSE 实时推送 |

## 目录结构

```
agent-monitor/
├── index.html                  # 仪表盘（Pages 根目录直接托管，与 web/agent-monitor 同步）
├── status.json                 # 云端快照（每 10 分钟由本机自动推送更新）
├── scripts/
│   ├── agent-monitor.mjs       # 采集器 + REST/SSE 服务
│   ├── publish-gh-pages.mjs    # 云端快照发布（内嵌于 monitor 定时执行）
│   └── com.dsh.agent-monitor.plist
└── README.md
```

## 许可证

MIT（按需修改）