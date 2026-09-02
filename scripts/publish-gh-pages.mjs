#!/usr/bin/env node
/**
 * publish-gh-pages.mjs — 把本机 Agent Monitor 的最新快照发布到 GitHub Pages 仓库
 *
 * 由 launchd（com.dsh.agent-monitor-pages，每 10 分钟）调用：
 *   1. 从本机监控服务（默认 http://127.0.0.1:8899）抓取 /api/agents 与 /api/system；
 *   2. 写入仓库根 status.json（真实快照，供 Pages 页面每 30s 拉取）；
 *   3. 同步最新仪表盘（单一源码 web/agent-monitor/index.html → 仓库 index.html）；
 *   4. 内容有变化才 git commit + push（GitHub Pages 自动重建，10 分钟节奏低于
 *      Pages 每小时 10 次的构建软限制）。
 *
 * 用法：
 *   MONITOR_API=http://127.0.0.1:8899 node scripts/publish-gh-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HARNESS = path.resolve(REPO, '..');                       // /Users/kolkie/harness
const DASHBOARD_SRC = path.join(HARNESS, 'web', 'agent-monitor', 'index.html');
const OUT_JSON = path.join(REPO, 'status.json');
const OUT_HTML = path.join(REPO, 'index.html');
const MONITOR_API = (process.env.MONITOR_API || 'http://127.0.0.1:8899').replace(/\/+$/, '');

async function getJson(p) {
  const r = await fetch(MONITOR_API + p, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status}`);
  return r.json();
}

function sh(cmd) {
  return execFileSync('bash', ['-lc', cmd], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  const [agents, system] = await Promise.all([getJson('/api/agents'), getJson('/api/system')]);

  const snapshot = {
    kind: 'agent-monitor-snapshot',
    generator: 'publish-gh-pages.mjs',
    at: Date.now(),
    hostname: system.hostname,
    pollMs: agents.pollMs ?? 5000,
    agents: agents.agents,
    system,
  };
  // 控制体积：日志/历史字段只留必要部分（/api/agents 列表本不含 logTail，这里兜底清理）
  snapshot.agents.forEach((a) => {
    if (typeof a.logTail === 'string') a.logTail = a.logTail.slice(-2000);
    if (Array.isArray(a.history)) a.history = a.history.slice(-120);
    delete a.logPath; delete a.logs;
  });

  const text = JSON.stringify(snapshot, null, 1) + '\n';
  let changed = false;

  const prev = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf8') : null;
  if (prev !== text) { fs.writeFileSync(OUT_JSON, text); changed = true; console.log('status.json: 已更新'); }
  else { console.log('status.json: 无变化'); }

  const dash = fs.existsSync(DASHBOARD_SRC) ? fs.readFileSync(DASHBOARD_SRC, 'utf8') : null;
  const cur = fs.existsSync(OUT_HTML) ? fs.readFileSync(OUT_HTML, 'utf8') : null;
  if (dash && dash !== cur) { fs.copyFileSync(DASHBOARD_SRC, OUT_HTML); changed = true; console.log('index.html: 已从 web 副本同步'); }

  if (!changed) { console.log('无变化，跳过推送'); return; }

  const status = sh('git status --porcelain');
  const allowed = status.split('\n').filter((l) => /(^| )status\.json|(^| )index\.html/.test(l));
  if (!allowed.length) { console.log('无可自动提交的变更（仅限 status.json / index.html）'); return; }

  sh('git add status.json index.html');
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  sh('git -c user.name="DSH Bot" -c user.email="dsh@localhost" commit -m "monitor: 更新云端状态快照 ' + ts + '"');
  try {
    sh('git push origin main');
  } catch {
    console.log('push 失败，先 rebase 再重试…');
    sh('git pull --rebase origin main');
    sh('git push origin main');
  }
  console.log('已推送 ✓');
}

main().catch((e) => { console.error('publish 失败:', e.message); process.exit(1); });