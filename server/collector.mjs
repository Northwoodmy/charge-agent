// ── 数据采集器：轮询小电拼本地 HTTP，维护最新状态 + 写历史 ──
import { config } from './config.mjs';
import { store } from './db.mjs';

export const state = {
  online: false,            // 设备是否可达
  latest: null,             // 最近一次 /metrics.json 原始数据
  processed: null,          // 加工后的看板数据
  historyRing: [],          // 近 2 分钟高频缓存（来自 porthistoryz）
  liveRing: [[], [], [], [], []], // 500ms 级实时环形缓冲（每口最多 30 分钟）
  events: [],               // 事件流（供前端/通知用）
  lastError: null,
};

const LIVE_CAP = 3600; // 30 分钟 × 2Hz

const PROTOCOL_NAMES = {
  0: 'DCP', 1: 'QC2.0', 2: 'QC3.0', 3: 'FCP', 4: 'SCP', 5: 'AFC',
  6: 'VOOC', 7: 'UFCS', 8: 'PD2.0', 9: 'PD3.0', 10: 'PPS',
  11: 'PD3.1', 12: 'AVS', 13: 'Mi', 16: 'PD3.1/PPS', 255: '未握手',
};

function emit(type, payload) {
  state.events.push({ type, payload, ts: Date.now() });
  if (state.events.length > 100) state.events.shift();
}

function processMetrics(raw) {
  const ports = raw.ports.map((p) => {
    const powerW = (p.voltage * p.current) / 1_000_000; // vout_mv × iout_ma / 1e6
    return {
      idx: p.id,                          // 0-4 设备原始索引
      no: p.id + 1,                       // 1-5（官方规范 1-indexed）
      name: p.id === 0 ? 'A' : `C${p.id}`, // A=1号位, C1..C4
      type: p.port_type,
      // 端口启停权威标志是 state（INACTIVE=已关闭）；active 字段有延迟，不可靠
      active: p.state !== 'INACTIVE',
      attached: p.attached,
      state: p.state,
      voltageV: p.voltage / 1000,
      currentA: p.current / 1000,
      powerW: Math.round(powerW * 100) / 100,
      budgetW: p.power_budget,
      protocolCode: p.fc_protocol,
      protocol: PROTOCOL_NAMES[p.fc_protocol] || `码${p.fc_protocol}`,
      durationS: p.charging_duration_seconds,
      sessionChargeC: p.session_charge,   // 微库仑 µC
      // E(Wh) = Q(µC)/1e6 × V / 3600
      sessionWh: Math.round(((p.session_charge / 1_000_000) * (p.voltage / 1000) / 3600) * 100) / 100,
    };
  });
  const totalW = Math.round(ports.reduce((s, p) => s + p.powerW, 0) * 10) / 10;
  const chargingPorts = ports.filter((p) => p.attached).length;
  return {
    ts: Date.now(),
    ports,
    totalW,
    chargingPorts,
    budgetTotalW: 160,
    system: raw.system,
  };
}

// 检测端口插拔事件（用于通知）
function detectEvents(prev, next) {
  if (!prev || !next) return;
  for (const p of next.ports) {
    const old = prev.ports.find((x) => x.idx === p.idx);
    if (!old) continue;
    if (!old.attached && p.attached) emit('attached', { port: p.name, no: p.no });
    if (old.attached && !p.attached && old.durationS > 60) emit('detached', { port: p.name, no: p.no, durationS: old.durationS, wh: old.sessionWh });
  }
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 经 HTTP 代理访问（Shadowrocket 类按应用 VPN 拦截直连时的兜底通道；纯 http 目标走绝对 URI 即可）
import http from 'node:http';
function fetchJsonViaProxy(url, proxy, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const px = new URL(proxy);
    const req = http.request(
      {
        host: px.hostname,
        port: px.port || 1082,
        path: url, // 绝对 URI：代理协议
        method: 'GET',
        timeout: timeoutMs,
        headers: { Host: target.host, Accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`代理HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('代理超时')));
    req.on('error', reject);
    req.end();
  });
}

// 双通道：直连优先；直连连续失败则冷却 60s（期间直连会挂起拖慢整轮采集，冷却保证代理满速）
let directBlockedUntil = 0;
let lastDirectErr = null;
async function fetchDevice(url, timeoutMs = 4000) {
  const now = Date.now();
  if (now >= directBlockedUntil) {
    try {
      const d = await fetchJson(url, timeoutMs);
      directBlockedUntil = 0;
      lastDirectErr = null;
      state.viaProxy = false;
      return d;
    } catch (e) {
      lastDirectErr = e;
      directBlockedUntil = now + 60_000; // 60 秒后再试直连
    }
  }
  if (!config.deviceProxy) throw lastDirectErr || new Error('设备不可达');
  try {
    const data = await fetchJsonViaProxy(url, config.deviceProxy, timeoutMs);
    state.viaProxy = true;
    return data;
  } catch (proxyErr) {
    state.viaProxy = false;
    throw lastDirectErr || proxyErr;
  }
}

async function tickMetrics() {
  try {
    const raw = await fetchDevice(`${config.deviceBaseUrl}/metrics.json`);
    const wasOnline = state.online;
    state.online = true;
    state.lastError = null;
    const prev = state.processed;
    state.latest = raw;
    state.processed = processMetrics(raw);
    // 500ms 级实时环形缓冲（供「实时滚动」曲线）
    const ts = state.processed.ts;
    for (const p of state.processed.ports) {
      const ring = state.liveRing[p.idx];
      ring.push([ts, p.powerW]);
      if (ring.length > LIVE_CAP) ring.splice(0, ring.length - LIVE_CAP);
    }
    if (!wasOnline) emit('online', {});
    detectEvents(prev, state.processed);
  } catch (e) {
    if (state.online) emit('offline', { error: String(e.message || e) });
    state.online = false;
    state.lastError = `${e.message || e}${e.cause ? ` (${e.cause.message || e.cause})` : ''}`;
  }
}

async function tickHistory() {
  if (!state.online) return;
  try {
    const raw = await fetchDevice(`${config.deviceBaseUrl}/porthistoryz`);
    const now = Date.now();
    const period = raw.sample_period_ms || 10000;
    const rows = [];
    state.historyRing = raw.ports.map((p) => ({
      port: p.port,
      samples: p.samples.map((s, i) => ({
        ts: now - (p.samples.length - 1 - i) * period,
        voltage_mv: s.voltage,
        current_ma: s.current,
        power_w: Math.round(((s.voltage * s.current) / 1_000_000) * 100) / 100,
      })),
    }));
    // 写入 SQLite：每个采样点一条（仅记录有功率或已连接的口，控制体积）
    for (const p of raw.ports) {
      for (const s of p.samples) {
        const powerW = (s.voltage * s.current) / 1_000_000;
        if (powerW > 0.05) {
          rows.push({
            ts: now - (p.samples.length - 1 - p.samples.indexOf(s)) * period,
            port: p.port, voltage_mv: s.voltage, current_ma: s.current,
            power_w: Math.round(powerW * 100) / 100, attached: 1,
          });
        }
      }
    }
    if (rows.length) store.addSamples(rows);
  } catch { /* 历史采集失败不影响主流程 */ }
}

let metricsTimer = null;
export function startCollector() {
  tickMetrics();
  metricsTimer = setInterval(tickMetrics, config.metricsIntervalMs);
  setInterval(tickHistory, config.historyIntervalMs);
  // 每日清理过期历史
  setInterval(() => store.purge(config.historyKeepDays), 6 * 3600_000);
}

// 运行时可调刷新速率（设置页 250ms–5s）
export function setMetricsInterval(ms) {
  config.metricsIntervalMs = ms;
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = setInterval(tickMetrics, ms);
  }
}
