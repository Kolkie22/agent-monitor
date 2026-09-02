#!/usr/bin/env node
/**
 * agent-monitor.mjs — 本机 Agent 状态监控（Collector + Server，零 npm 依赖）
 *
 * 架构：Collector 每 5s 用 4 类只读探针（launchctl / 端口 / 状态文件 / 日志活性）
 * 采集 OpenClaw、Hermes、cc-connect、DSH(Lark/微信)、Ollama、WorkBuddy 的状态，
 * 统一为 AgentStatus 快照；Server 提供 REST / SSE / 静态仪表盘 / 受控重启动作。
 *
 * 用法：
 *   node scripts/agent-monitor.mjs            # 默认 127.0.0.1:8899
 *   PORT=8899 node scripts/agent-monitor.mjs  # 换端口
 *   curl http://127.0.0.1:8899/api/agents
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(HARNESS, '.dsh-home');
const CFG_PATH = path.join(DSH_HOME, 'agent-monitor.json');
const HISTORY_DIR = path.join(DSH_HOME, 'agent-monitor', 'history');
const DASHBOARD = path.join(HARNESS, 'web', 'agent-monitor', 'index.html');
const UID = process.getuid();

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8899;

/* ============================================================
 * GitHub Pages 云端快照发布
 * 复用常驻进程（launchd KeepAlive）：启动 30s 后推一次，之后每 10 分钟推一次。
 * 脚本把最新 /api/agents + /api/system 写入仓库 status.json 并 git push，
 * GitHub Pages 自动重建；页面端每 30s 拉取（raw 直读 + 同源兜底）。
 * ============================================================ */
const PUBLISH_SCRIPT = process.env.PUBLISH_SCRIPT
  || path.join(HARNESS, 'agent-monitor', 'scripts', 'publish-gh-pages.mjs');
const PUBLISH_EVERY_MS = Number(process.env.PUBLISH_EVERY_MS) || 10 * 60 * 1000;

function runPublish() {
  if (process.env.DISABLE_PUBLISH === '1') return;
  if (!fs.existsSync(PUBLISH_SCRIPT)) { console.warn('[publish] 脚本不存在: ' + PUBLISH_SCRIPT); return; }
  const child = spawn(process.execPath, [PUBLISH_SCRIPT], {
    detached: true,
    env: { ...process.env, DSH_GIT_FORGE_PROJECT: HARNESS, DSH_HOME, HOME: os.homedir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code) => {
    const tail = out.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
    if (code === 0) console.log(`[publish] 完成: ${tail}`);
    else console.error(`[publish] 失败 exit=${code}: ${tail}`);
  });
}
const POLL_MS = Number(process.env.POLL_MS) || 5000;
const MAX_HISTORY = Math.floor((24 * 3600 * 1000) / POLL_MS); // 24h 环形缓冲
const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const LOG_STALE_DEFAULT_MIN = 10;
const ERROR_RE = /\b(level=error|\[error\]|traceback|exception|panic|crash(?:ed|es)?|fatal)\b/i;
const ERROR_WORD_RE = /\berror\b/i;
// 良性噪声豁免：工具回执 “item error”；Lark WS 正常关闭重连（close 帧 1000(OK)）；
// session 清理（pruning stale）；“无错误”类短语；以及嵌入消息正文的 error 字样（head='…' 载荷）
const ERROR_NOISE_RE = /item error|receive message loop exit, err: sent \d{3,4} \(OK\); then received \d{3,4} \(OK\) bye|pruning stale sessions?\.json entry|no error|without error|error-free|head='[^']*\berror\b[^']*'|head="[^"]*\berror\b[^"]*"/i;
function isErrorLine(l) {
  if (ERROR_RE.test(l) && !ERROR_NOISE_RE.test(l)) return true;
  return ERROR_WORD_RE.test(l) && !ERROR_NOISE_RE.test(l); // 排除良性噪声
}
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,}|AKIA[A-Z0-9]{16})\b/g;

/* ============================================================
 * Agent 探针配置矩阵（来自架构方案“现状盘点”）
 * ============================================================ */
const AGENTS = [
  {
    id: 'openclaw', name: 'OpenClaw', category: 'agent',
    launchdLabel: 'ai.openclaw.gateway', port: 18789,
    logs: [path.join(os.homedir(), 'Library/Logs/openclaw/gateway.log')],
    stateFile: null, logStaleMin: 30,
  },
  {
    // Hermes：网关不再监听固定 TCP 端口（历史口径 :9119 已废弃），
    // 以 launchd + gateway_state.json（权威状态，含 feishu 连接态）+ 日志活性判定。
    id: 'hermes', name: 'Hermes', category: 'agent',
    launchdLabel: 'ai.hermes.gateway', port: null,
    logs: [path.join(os.homedir(), '.hermes/logs/gateway.log'),
           path.join(os.homedir(), '.hermes/logs/gateway.error.log')],
    stateFile: path.join(os.homedir(), '.hermes/gateway_state.json'),
    logStaleMin: 90,
    statePick: (s) => ({
      gateway_state: s.gateway_state,
      feishu: s.platforms?.feishu?.state,
      session_store: s.session_store?.status,
      active_agents: s.active_agents,
      version: (s.code_sha || '').slice(0, 8),
    }),
  },
  {
    id: 'cc-connect', name: 'cc-connect', category: 'agent',
    launchdLabel: 'com.cc-connect.service', port: null,
    logs: [path.join(os.homedir(), '.cc-connect/logs/cc-connect.log')],
    stateFile: null, logStaleMin: null, // 空闲期长属正常，日志仅作活动参考
  },
  {
    // DSH Lark 通道：IM 通道空闲期长属正常（与微信桥口径一致），
    // 以 launchd KeepAlive 存活为主信号，日志仅作消息活动参考。
    id: 'dsh-lark', name: 'DSH · Lark', category: 'channel',
    launchdLabel: 'dev.omdsh.dsh-lark', port: null,
    logs: [path.join(os.homedir(), '.dsh-lark-channel.log')],
    stateFile: null, logStaleMin: null,
  },
  {
    id: 'dsh-wechat', name: 'DSH · 微信桥', category: 'channel',
    // 桥接进程端口为动态分配（每次重启变化，如 49664/49724），不能按端口探活；
    // 以 launchd KeepAlive 存活为主信号，plugin.log 仅作消息活动参考（空闲期长属正常）。
    launchdLabel: 'dev.omdsh.dsh-wechat', port: null,
    logs: [path.join(DSH_HOME, 'wechat-bridge/plugin.log')],
    stateFile: null, logStaleMin: null,
  },
  {
    id: 'ollama', name: 'Ollama', category: 'runtime',
    launchdLabel: 'homebrew.mxcl.ollama', port: 11434,
    logs: [], stateFile: null, logStaleMin: null,
  },
  {
    // WorkBuddy：Electron 桌面应用/网关 :65221 为手动启动、不常驻（2026-09-02 起
    // 以常驻的飞书桥 LaunchAgent 为准，KeepAlive 自动拉起）。桥空闲期不写日志属
    // 正常，日志仅作活动参考，不参与降级判定。
    id: 'workbuddy', name: 'WorkBuddy · 飞书桥', category: 'channel',
    launchdLabel: 'com.workbuddy.feishu-bridge', port: null,
    logs: [path.join(os.homedir(), 'Library/Logs/workbuddy-feishu-bridge.log')],
    stateFile: null, logStaleMin: null,
  },
];

/* ============================================================
 * 配置（token / 端口），首次运行自动生成
 * ============================================================ */
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (c.token) return c;
  } catch { /* 首次运行 */ }
  const cfg = { token: crypto.randomBytes(24).toString('base64url'), port: PORT, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`[monitor] 已生成配置 ${CFG_PATH} (token 用于写操作)`);
  return cfg;
}
const CONFIG = loadConfig();

function maskSecret(s) {
  return String(s || '').replace(SECRET_RE, '<masked>');
}

/* ============================================================
 * 系统资源采集（CPU / 内存 / 磁盘，随轮询实时刷新）
 * ============================================================ */
let prevCpuTimes = null;      // os.cpus() 上一轮 ticks，用于算 CPU 占用率
let systemSnap = null;        // 最新系统指标快照
const sysHistory = [];        // [{t, cpu, mem, disk}] 环形缓冲
const MAX_SYS_HISTORY = 720;  // 5s × 720 ≈ 1h

// 系统自留的隐藏小卷 / devfs 不展示，只留用户可见的物理卷
const DISK_EXCLUDE = new Set([
  '/dev', '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update',
  '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware',
  '/System/Volumes/Data/home',
]);

function cpuUsage() {
  const cpus = os.cpus();
  const nowTicks = cpus.map((c) => c.times);
  if (!prevCpuTimes || nowTicks.length !== prevCpuTimes.length) {
    prevCpuTimes = nowTicks; // 首轮只有基线，usage 为 null（页面显示 —）
    return { usage: null, perCore: null };
  }
  const perCore = cpus.map((c, i) => {
    const p = prevCpuTimes[i] || {};
    let total = 0;
    for (const k of Object.keys(c.times)) total += c.times[k] - (p[k] || 0);
    if (total <= 0) return null;
    const idle = Math.max(0, c.times.idle - (p.idle || 0));
    return Math.min(1, 1 - idle / total); // 该核区间占用率 0..1
  });
  prevCpuTimes = nowTicks;
  const valid = perCore.filter((v) => v !== null);
  const usage = valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
  return { usage, perCore };
}

async function collectDisks() {
  // df -kP（POSIX）：Filesystem 1024-blocks Used Available Capacity Mounted on
  const r = await exec('df', ['-kP'], 3000);
  const out = [];
  if (r.ok) {
    for (const line of r.stdout.split('\n').slice(1)) {
      const t = line.trim().split(/\s+/);
      if (t.length < 6) continue;
      const [fs, blocks, used, avail, cap] = t;
      const mount = t.slice(5).join(' '); // 挂载点可能含空格，取尾部拼接
      if (!fs.startsWith('/dev/disk')) continue; // 只收物理本地盘（排除 devfs/map/合成挂载）
      if (DISK_EXCLUDE.has(mount)) continue;
      const scale = 1024; // df 每列单位是 1024 字节块
      out.push({
        fs, mount,
        total: Number(blocks) * scale,
        used: Number(used) * scale,
        free: Number(avail) * scale,
        usage: parseFloat(cap) / 100,
      });
    }
  }
  if (!out.length) { // df 不可用兜底：主卷 statfs
    try {
      const s = fs.statfsSync('/');
      out.push({
        fs: 'statfs', mount: '/',
        total: s.blocks * s.bsize,
        used: (s.blocks - s.bfree) * s.bsize,
        free: s.bfree * s.bsize,
        usage: s.blocks ? 1 - s.bfree / s.blocks : 0,
      });
    } catch {}
  }
  return out;
}

async function memStats() {
  // macOS 口径：os.freemem() 只算 Pages free（把缓存/惰性页都算"已用"，数值吓人）。
  // 正确口径：可用 = free + inactive + speculative + purgeable（均可随时回收），
  // 真实已用 = total − 可用；另附压缩内存与 Swap 辅助指标。
  const total = os.totalmem();
  const r = await exec('vm_stat', [], 3000);
  if (r.ok) {
    const m = {};
    for (const line of r.stdout.split('\n')) {
      const hit = line.match(/^(\w[\w ]*?):\s+(\d+)/);
      if (hit) m[hit[1].toLowerCase().replace(/\s+/g, '')] = parseInt(hit[2], 10);
    }
    const psHit = r.stdout.match(/page size of (\d+) bytes/);
    const psize = psHit ? parseInt(psHit[1], 10) : 16384;
    const g = (k) => (m[k] != null ? m[k] * psize : 0);
    const b = {
      free: g('pagesfree'), inactive: g('pagesinactive'), speculative: g('pagesspeculative'),
      purgeable: g('pagespurgeable'), active: g('pagesactive'), wired: g('pageswireddown'),
      compressed: g('pagesoccupiedbycompressor'),
    };
    const avail = b.free + b.inactive + b.speculative + b.purgeable;
    const used = Math.max(0, total - avail);
    let swap = null;
    const sw = await exec('sysctl', ['vm.swapusage'], 3000);
    if (sw.ok) {
      const mm = sw.stdout.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/);
      if (mm) swap = {
        total: parseFloat(mm[1]) * 1024 * 1024,
        used: parseFloat(mm[2]) * 1024 * 1024,
        free: parseFloat(mm[3]) * 1024 * 1024,
      };
    }
    return {
      total, used, free: avail, rawFree: os.freemem(),
      usage: total ? used / total : 0,
      breakdown: b, swap, source: 'vm_stat',
    };
  }
  // 兜底：vm_stat 不可用退化为 os 口径
  const fre = os.freemem();
  return {
    total, used: total - fre, free: fre, rawFree: fre,
    usage: total ? 1 - fre / total : 0,
    breakdown: { free: fre }, swap: null, source: 'os',
  };
}

async function collectSystem() {
  const cpu = cpuUsage();
  const cpus = os.cpus();
  const disksArr = await collectDisks();
  const mem = await memStats();
  // 主卷：优先包含用户主目录的 Data 卷，否则根卷
  const primary = disksArr.find((d) => d.mount === '/System/Volumes/Data')
    || disksArr.find((d) => d.mount === '/') || null;
  return {
    at: Date.now(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    uptimeSec: Math.round(os.uptime()),
    loadavg: os.loadavg(),
    cpu: { count: cpus.length, model: cpus[0] ? cpus[0].model : null, usage: cpu.usage, perCore: cpu.perCore },
    mem,
    disks: disksArr,
    primary,
    monitor: { token: CONFIG.token.slice(0, 6) + '…', port: PORT },
  };
}

async function refreshSystemMetrics() {
  try {
    systemSnap = await collectSystem();
    const s = systemSnap;
    sysHistory.push({ t: s.at, cpu: s.cpu.usage, mem: s.mem.usage, disk: s.primary ? s.primary.usage : null });
    if (sysHistory.length > MAX_SYS_HISTORY) sysHistory.splice(0, sysHistory.length - MAX_SYS_HISTORY);
  } catch (e) {
    console.error('[monitor] system metrics failed:', e);
  }
}

/* ============================================================
 * 探针
 * ============================================================ */
function exec(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, code: err.code, msg: String(err.message || '') });
          resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    } catch (e) {
      // spawn 本身失败（如受限环境 EPERM）→ 当作探针不可用，绝不崩掉轮询
      resolve({ ok: false, code: e.code || 'SPAWN_ERR', msg: String(e.message || e) });
    }
  });
}

async function launchctlPrint(label) {
  const r = await exec('launchctl', ['print', `gui/${UID}/${label}`], 3000);
  if (!r.ok) {
    // 兜底：launchctl list（PID \t Status \t Label）
    const l = await exec('launchctl', ['list'], 3000);
    for (const line of (l.ok ? l.stdout : '').split('\n')) {
      const m = line.match(/^\s*(\d+|-)\s+(-?\d+)\s+(.+)$/);
      if (m && m[3].trim() === label) {
        const pid = m[1] === '-' ? null : parseInt(m[1], 10);
        return { ok: true, state: pid ? 'running' : 'not-running', pid, lastExitCode: Number(m[2]) || null, running: !!pid };
      }
    }
    return { ok: false, state: null, pid: null, lastExitCode: null, running: false, reason: 'not-found' };
  }
  const out = r.stdout;
  const pidM = out.match(/pid = (\d+)/);
  const stateM = out.match(/state = (\w+)/);
  const exitM = out.match(/last exit code = (-?\d+)/);
  const state = stateM ? stateM[1] : null;
  const pid = pidM ? parseInt(pidM[1], 10) : null;
  const running = state === 'running' && pid !== null;
  return { ok: true, state, pid, lastExitCode: exitM ? parseInt(exitM[1], 10) : null, running,
           reason: state === 'running' && pid === null ? 'state=running 但未解析到 pid' : undefined };
}

function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const s = net.connect({ host: HOST, port, timeout: timeoutMs });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

function tailFile(file) {
  try {
    const st = fs.statSync(file);
    const size = st.size;
    if (!size) return { mtime: st.mtimeMs, size: 0, lines: [], error: null };
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
    return { mtime: st.mtimeMs, size, lines: lines.slice(-TAIL_LINES), error: null };
  } catch (e) {
    return { mtime: 0, size: 0, lines: [], error: String(e.message || e) };
  }
}

async function pidUptime(pid) {
  if (!pid) return null;
  // macOS ps 无 etimes 关键字（实测报 “keyword not found”），用 etime（[[dd-]hh:]mm:ss）解析
  const r = await exec('ps', ['-o', 'etime=', '-p', String(pid)], 1500);
  if (r.ok) {
    const m = r.stdout.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (m) {
      const d = parseInt(m[1] || '0', 10), h = parseInt(m[2] || '0', 10);
      const mm = parseInt(m[3], 10), ss = parseInt(m[4], 10);
      return ((d * 24 + h) * 60 + mm) * 60 + ss;
    }
    const v = parseInt(r.stdout.trim(), 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null; // 沙箱/受限环境拿不到 ps 时降级为 null，页面显示 —
}

/* ============================================================
 * 每进程内存/CPU 探针：每轮 pollAll 跑一次 ps，按 PID 建表供各 agent 查
 * (macOS ps -o rss=rssKb vsz=vszKb pcpu=%) 实测输出：<pid> <rssKB> <vszKB> <pcpu>
 * ============================================================ */
let procMem = new Map(); // pid -> { rssKb, vszKb, cpuPct }

async function refreshProcMem() {
  const map = new Map();
  try {
    const r = await exec('ps', ['-axo', 'pid=,rss=,vsz=,pcpu='], 3000);
    if (r.ok) {
      for (const line of r.stdout.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 4) {
          const pid = parseInt(f[0], 10);
          if (!Number.isFinite(pid)) continue;
          map.set(pid, {
            rssKb: parseInt(f[1], 10) || 0,
            vszKb: parseInt(f[2], 10) || 0,
            cpuPct: Number.isFinite(parseFloat(f[3])) ? parseFloat(f[3]) : null,
          });
        }
      }
    }
  } catch { /* ps 不可用时保持空表，卡片不显示内存 */ }
  procMem = map;
}

/* ============================================================
 * 状态判定 + 快照
 * ============================================================ */
const snapshots = new Map();   // id -> 最近 AgentStatus（含 logTail 等详情）
const history = new Map();     // id -> [{t, up}]   up: 1=up 0.5=degraded 0=down null=unknown
const prevStatus = new Map();  // id -> status（用于 SSE 变更检测）

function decideStatus(a, ld, portOpen, log) {
  const now = Date.now();
  const reason = [];
  const signalOK = [];
  if (a.launchdLabel) signalOK.push({ name: 'launchd', ok: !!(ld && ld.running) });
  if (a.port) signalOK.push({ name: `port:${a.port}`, ok: !!portOpen });

  let status;
  let extraNote = null;
  if (signalOK.length === 0) {
    // 无探针（如 WorkBuddy 预留位）
    const exists = a.probe === 'dir' ? fs.existsSync(a.probeArg) : true;
    status = 'unknown';
    extraNote = a.note || '无探针配置';
    if (a.probe === 'dir' && !exists) extraNote = '未检测到安装目录（预留位）';
  } else {
    const bad = signalOK.filter((s) => !s.ok);
    if (bad.length === signalOK.length) {
      status = 'down';
      reason.push(`信号全断（${bad.map((s) => s.name).join('/')}）`);
    } else if (bad.length > 0) {
      status = 'degraded';
      reason.push(`信号异常：${bad.map((s) => s.name).join('/')}`);
    } else {
      status = 'up';
    }
    if (ld && ld.ok && !ld.running && ld.reason) reason.push(ld.reason);
  }

  // 日志活性（配置了才判）
  let errLines = 0;
  let lastActivityAt = null;
  let lastErrorAt = null;
  if (log && log.lines.length) {
    errLines = log.lines.filter(isErrorLine).length;
    lastActivityAt = log.mtime;
    if (a.logStaleMin && status === 'up') {
      const ageMin = (now - log.mtime) / 60000;
      if (ageMin > a.logStaleMin) {
        status = 'degraded';
        reason.push(`日志停滞 ${Math.round(ageMin)}min`);
      }
    }
    if (status === 'up' && errLines > 0 && a.logStaleMin !== null) {
      status = 'degraded';
      reason.push(`尾部 ${errLines} 条疑似错误`);
    }
    if (errLines > 0) lastErrorAt = log.mtime;
  }
  if (status === 'up' && lastActivityAt === null && a.port) lastActivityAt = now; // 端口通但无日志
  return { status, reason, errLines, lastActivityAt, lastErrorAt, extraNote };
}

async function pollAgent(a) {
  const t0 = Date.now();
  const ld = a.launchdLabel ? await launchctlPrint(a.launchdLabel) : null;
  const portOpen = a.port ? await probePort(a.port) : null;
  let log = null;
  if (a.logs && a.logs.length) {
    const tails = a.logs.map((f) => tailFile(f)).filter((t) => t.error === null || t.mtime > 0);
    log = tails.sort((x, y) => y.mtime - x.mtime)[0] || { mtime: 0, size: 0, lines: [], error: null };
  }
  let stateInfo = null;
  if (a.stateFile) {
    try {
      const j = JSON.parse(fs.readFileSync(a.stateFile, 'utf8'));
      stateInfo = a.statePick ? a.statePick(j) : j;
    } catch (e) { stateInfo = { parseError: String(e.message || e) }; }
  }
  const uptime = ld && ld.pid ? await pidUptime(ld.pid) : null;
  const pm = (ld && ld.pid && procMem.get(ld.pid)) || null; // 每进程内存/CPU（macOS ps）
  const dec = decideStatus(a, ld, portOpen, log);
  const ms = Date.now() - t0;

  const snap = {
    id: a.id, name: a.name, category: a.category,
    status: dec.status, reason: dec.reason, extraNote: dec.extraNote,
    pid: ld ? ld.pid : null, launchdState: ld ? ld.state : null,
    port: a.port, portOpen, uptimeSec: uptime,
    memRssKb: pm ? pm.rssKb : null, memVszKb: pm ? pm.vszKb : null, cpuPct: pm ? pm.cpuPct : null,
    lastActivityAt: dec.lastActivityAt, lastErrorAt: dec.lastErrorAt,
    errorRecent: dec.errLines,
    logTail: log ? maskSecret(log.lines.slice(-60).join('\n')) : '',
    logMtime: log ? log.mtime : null,
    state: stateInfo,
    pollMs: Math.round(ms), probedAt: Date.now(),
  };
  snapshots.set(a.id, snap);

  // 历史点 + JSONL
  const upVal = dec.status === 'up' ? 1 : dec.status === 'degraded' ? 0.5 : dec.status === 'down' ? 0 : null;
  const arr = history.get(a.id) || [];
  arr.push({ t: Date.now(), up: upVal });
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  history.set(a.id, arr);
  try {
    const d = dateStr();
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(path.join(HISTORY_DIR, `${a.id}-${d}.jsonl`),
      JSON.stringify({ t: Date.now(), s: dec.status, up: upVal }) + '\n');
  } catch { /* 磁盘异常不阻塞监控 */ }

  const changed = prevStatus.get(a.id) !== dec.status || (lastEventAt.get(a.id) || 0) < (dec.lastActivityAt || 0);
  if (changed) lastEventAt.set(a.id, Date.now());
  prevStatus.set(a.id, dec.status);
  return { changed };
}

const lastEventAt = new Map();
let initialized = false;

async function pollAll() {
  await refreshSystemMetrics(); // CPU/内存/磁盘 每轮实时采集，SSE 每轮推送
  await refreshProcMem();       // 每轮刷新 pid -> RSS/VSZ/CPU 映射（各 agent 卡片显示内存占用）
  const results = await Promise.allSettled(AGENTS.map(pollAgent));
  if (!initialized) { initialized = true; await backfillHistory(); }
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error(`[monitor] poll ${AGENTS[i].id} failed:`, results[i].reason);
    }
  }
  const anyChange = results.some((r) => r.status === 'fulfilled' && r.value.changed);
  if (anyChange) broadcastSnapshot();
  broadcastSystem(); // 系统指标不依赖 agent 变更，每轮都推
}

function backfillHistory() {
  // 开机回填当日 JSONL，暖出 24h 时间线
  const today = dateStr();
  for (const a of AGENTS) {
    try {
      const f = path.join(HISTORY_DIR, `${a.id}-${today}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const arr = history.get(a.id) || [];
      for (const line of lines.slice(-Math.min(2000, MAX_HISTORY))) {
        try { const j = JSON.parse(line); arr.push({ t: j.t, up: j.up }); } catch {}
      }
      const trimmed = arr.slice(-MAX_HISTORY);
      history.set(a.id, trimmed);
    } catch {}
  }
}

function dateStr() { return new Date().toISOString().slice(0, 10); }

/* ============================================================
 * Server（REST + SSE + 静态页）
 * ============================================================ */
const sseClients = new Set();

function broadcastSnapshot() {
  const json = JSON.stringify({ type: 'snapshot', at: Date.now(), agents: summaryList() });
  for (const res of sseClients) res.write(`data: ${json}\n\n`);
}

function broadcastSystem() {
  if (!systemSnap) return;
  const json = JSON.stringify({ type: 'system', at: systemSnap.at, sys: systemSnap });
  for (const res of sseClients) res.write(`data: ${json}\n\n`);
}

function summaryList() {
  return AGENTS.map((a) => {
    const s = snapshots.get(a.id);
    if (!s) return { id: a.id, name: a.name, category: a.category, status: 'unknown', reason: ['首次采集未完成'] };
    const { logTail, ...rest } = s;
    return rest;
  });
}

async function agentDetail(id) {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) return null;
  const s = snapshots.get(id);
  if (!s) return { id, name: a.name, status: 'unknown', reason: ['尚未采集'] };
  const hist = (history.get(id) || []).slice(-720).map((p) => ({ t: p.t, up: p.up }));
  return { ...s, history: hist };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function isTokenOk(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i) || req.url.match(/[?&]token=([^&]+)/);
  const token = m ? m[1] : '';
  if (!token) return false;
  const a = Buffer.from(token), b = Buffer.from(CONFIG.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function runAction(a, action) {
  if (!a.launchdLabel) return { ok: false, error: '该 agent 无 launchd 服务，不支持启停' };
  let args;
  if (action === 'restart') args = ['kickstart', '-k', `gui/${UID}/${a.launchdLabel}`];
  else if (action === 'start') args = ['start', `gui/${UID}/${a.launchdLabel}`];
  else if (action === 'stop') args = ['stop', `gui/${UID}/${a.launchdLabel}`];
  else return { ok: false, error: `未知动作 ${action}` };
  const r = await exec('launchctl', args, 8000);
  if (r.ok) setTimeout(pollAll, 2000); // 动作后尽快刷新
  return { ok: r.ok, stdout: maskSecret(r.stdout.trim()), stderr: maskSecret(r.stderr.trim()) };
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => { res.write(`: heartbeat ${Date.now()}\n\n`); }, 20000);
  res.on('close', () => { clearInterval(hb); sseClients.delete(res); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;
  // CORS：允许 GitHub Pages 等站点跨域读取（写操作仍需 Bearer token）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (p === '/events' && req.method === 'GET') return sse(res);
    if (p === '/') {
      if (fs.existsSync(DASHBOARD)) {
        const html = fs.readFileSync(DASHBOARD, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      return sendJson(res, 404, { error: 'dashboard 未找到: web/agent-monitor/index.html' });
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (p === '/api/agents' && req.method === 'GET') {
      return sendJson(res, 200, { at: Date.now(), pollMs: POLL_MS, agents: summaryList() });
    }
    if (p === '/api/system' && req.method === 'GET') {
      if (!systemSnap) await refreshSystemMetrics();
      const hist = sysHistory.slice(-240).map((h) => ({ t: h.t, cpu: h.cpu, mem: h.mem, disk: h.disk }));
      return sendJson(res, 200, { ...(systemSnap || {}), history: hist });
    }

    const am = p.match(/^\/api\/agents\/([\w-]+)(?:\/(log|history|restart|start|stop))?$/);
    if (am) {
      const [, id, sub] = am;
      const a = AGENTS.find((x) => x.id === id);
      if (!a) return sendJson(res, 404, { error: `未找到 agent: ${id}` });
      const detail = await agentDetail(id);
      if (!detail) return sendJson(res, 404, { error: `${id} 尚无快照` });

      if (!sub) return sendJson(res, 200, detail);
      if (sub === 'log') {
        const lines = Math.min(500, Math.max(20, parseInt(u.searchParams.get('lines') || '120', 10) || 120));
        const s = snapshots.get(id);
        const all = s.logTail ? s.logTail.split('\n') : [];
        return sendJson(res, 200, { id, lines: all.slice(-lines), logMtime: s.logMtime });
      }
      if (sub === 'history') {
        const n = Math.min(4320, parseInt(u.searchParams.get('points') || '720', 10) || 720);
        return sendJson(res, 200, { id, points: (history.get(id) || []).slice(-n) });
      }
      // 写动作：token 门控
      if (req.method === 'POST') {
        if (!isTokenOk(req)) return sendJson(res, 401, { error: '未授权：需要 Bearer token（页面右上角填入）' });
        const r = await runAction(a, sub);
        return sendJson(res, r.ok ? 200 : 500, { action: sub, ...r });
      }
      return sendJson(res, 405, { error: '仅支持 POST' });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

/* ============================================================
 * 启动
 * ============================================================ */
fs.mkdirSync(HISTORY_DIR, { recursive: true });
// 清理 7 天前的历史文件
try {
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const age = Date.now() - fs.statSync(path.join(HISTORY_DIR, f)).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) fs.unlinkSync(path.join(HISTORY_DIR, f));
  }
} catch {}

server.listen(PORT, HOST, () => {
  console.log(`[monitor] agent-monitor 已启动: http://${HOST}:${PORT}  (token: ${CONFIG.token.slice(0, 6)}…)`);
  console.log(`[monitor] 配置: ${CFG_PATH}; 历史: ${HISTORY_DIR}; agents=${AGENTS.length}; poll=${POLL_MS}ms`);
  pollAll().catch((e) => console.error('[monitor] initial poll failed:', e));
  setInterval(() => pollAll().catch((e) => console.error('[monitor] poll failed:', e)), POLL_MS).unref();
  // 云端快照发布（启动后 30s 首次，之后每 10 分钟一次；GitHub Pages 状态保持最新）
  setTimeout(runPublish, 30 * 1000).unref();
  setInterval(runPublish, PUBLISH_EVERY_MS).unref();
});