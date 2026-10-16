// ── Express API：数据 / MCP / Agent / 设置 ─────────────────
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from './cors-shim.mjs';
import { config, PROVIDERS, settings } from './config.mjs';
import { state, startCollector, setMetricsInterval } from './collector.mjs';
import { store } from './db.mjs';
import { mcp, ensureMcp } from './mcp-client.mjs';
import { chat, directControl, directQuery } from './agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors);
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(`[API错误] ${req.method} ${req.path}:`, e);
  res.status(500).json({ ok: false, error: String(e.message || e) });
});

// ── 设备数据 ──
app.get('/api/config', (req, res) => {
  res.json({ ok: true, metricsIntervalMs: config.metricsIntervalMs, historyIntervalMs: config.historyIntervalMs });
});

app.get('/api/status', (req, res) => {
  res.json({ online: state.online, data: state.processed, lastError: state.lastError, viaProxy: !!state.viaProxy });
});

// 500ms 级实时环形缓冲（最近 N 秒，默认 10 分钟）
app.get('/api/live', (req, res) => {
  const seconds = Math.min(Number(req.query.seconds || 600), 1800);
  const since = Date.now() - seconds * 1000;
  res.json({
    ok: true,
    ports: state.liveRing.map((ring, port) => ({ port, points: ring.filter(([ts]) => ts >= since) })),
  });
});

app.get('/api/history', (req, res) => {
  const port = Number(req.query.port || 0);
  const minutes = Math.min(Number(req.query.minutes || 60), 24 * 60);
  res.json({ ok: true, port, samples: store.getHistory(port, minutes) });
});

app.get('/api/stats', (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  // 按口分组、按时间排序，用相邻采样时间差积分：Σ P × Δt（Δt 封顶 30s，防空档高估）
  // 采样密度不固定（历史窗口重叠/早期高频写入），固定 10s 假设会失真
  let wh = 0;
  let sampleCount = 0;
  const activePorts = new Set();
  for (let port = 0; port <= 4; port++) {
    const rows = store.getHistory(port, 24 * 60).filter((r) => r.ts >= startOfDay.getTime());
    let prev = null;
    for (const r of rows) {
      const dt = prev == null ? 10_000 : Math.min(r.ts - prev, 30_000);
      if (dt > 0) { wh += r.power_w * (dt / 1000); sampleCount++; }
      prev = r.ts;
      if (r.power_w > 0.5) activePorts.add(port);
    }
  }
  res.json({ ok: true, todayWh: Math.round((wh / 3600) * 10) / 10, activePortsToday: activePorts.size, debug: { samples: sampleCount, rawWs: Math.round(wh) } });
});

app.get('/api/events', (req, res) => {
  const since = Number(req.query.since || 0);
  res.json({ ok: true, events: state.events.filter((e) => e.ts > since) });
});

// ── MCP ──
app.get('/api/mcp/status', (req, res) => {
  res.json({ ok: true, connected: mcp.connected, url: config.mcpUrl, toolCount: mcp.tools.length, tools: mcp.tools.map((t) => t.name) });
});

app.post('/api/mcp/reconnect', wrap(async (req, res) => {
  try { await ensureMcp(); res.json({ ok: true, connected: true, tools: mcp.tools.map((t) => t.name) }); }
  catch (e) { res.json({ ok: false, error: String(e.message || e), connected: false }); }
}));

app.post('/api/control', wrap(async (req, res) => {
  const { tool, args } = req.body || {};
  const result = await directControl(tool, args);
  res.json(result);
}));

app.post('/api/mcp/query', wrap(async (req, res) => {
  const { tool, args } = req.body || {};
  const result = await directQuery(tool, args);
  res.json(result);
}));

// ── Agent 对话 ──
app.post('/api/agent/chat', wrap(async (req, res) => {
  const { sessionId, message, provider } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'message 必填' });
  const result = await chat({ sessionId, message, provider });
  res.json(result);
}));

app.get('/api/agent/sessions', (req, res) => {
  res.json({ ok: true, sessions: store.listSessions() });
});

app.get('/api/agent/sessions/:id/messages', (req, res) => {
  res.json({ ok: true, messages: store.getMessages(req.params.id, 500) });
});

// ── 设置 ──
const maskKey = (k) => (k ? `${k.slice(0, 6)}••••${k.slice(-4)}` : '');

app.get('/api/settings', (req, res) => {
  res.json({
    ok: true,
    provider: settings.provider,
    deviceBaseUrl: config.deviceBaseUrl,
    deviceProxy: config.deviceProxy,
    metricsIntervalMs: config.metricsIntervalMs,
    mcpUrl: config.mcpUrl,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, label: p.label, model: p.model,
      hasKey: Boolean(p.apiKey), maskedKey: maskKey(p.apiKey),
    })),
  });
});

app.post('/api/settings', wrap(async (req, res) => {
  const { provider, deviceBaseUrl, deviceProxy, mcpUrl, keys, models, metricsIntervalMs } = req.body || {};
  const applied = [];

  // 数据刷新速率（250ms–5s）
  if (metricsIntervalMs !== undefined) {
    const ms = Number(metricsIntervalMs);
    if (!Number.isFinite(ms) || ms < 250 || ms > 5000) {
      return res.status(400).json({ ok: false, error: '刷新速率需在 250–5000ms 之间' });
    }
    setMetricsInterval(Math.round(ms));
    store.setKV('metrics_interval_ms', String(Math.round(ms)));
    applied.push('刷新速率');
  }

  // 设备 IP/地址
  if (deviceBaseUrl) {
    if (!/^https?:\/\/[\w.:-]+/.test(deviceBaseUrl)) {
      return res.status(400).json({ ok: false, error: '设备地址格式不正确，例如 http://192.168.8.68' });
    }
    config.deviceBaseUrl = deviceBaseUrl.replace(/\/+$/, '');
    store.setKV('device_base_url', config.deviceBaseUrl);
    applied.push('设备地址');
  }

  // 设备兜底代理（可选：直连被按应用 VPN 拦截时走这里）
  if (deviceProxy !== undefined) {
    const p = String(deviceProxy || '').trim();
    if (p && !/^https?:\/\/[\w.:-]+/.test(p)) {
      return res.status(400).json({ ok: false, error: '代理地址格式不正确，例如 http://127.0.0.1:1082' });
    }
    config.deviceProxy = p || null;
    store.setKV('device_proxy', p);
    applied.push('设备代理');
  }

  // MCP 地址（含 PSN 与 token）
  if (mcpUrl) {
    if (!/^https?:\/\//.test(mcpUrl)) {
      return res.status(400).json({ ok: false, error: 'MCP 地址格式不正确' });
    }
    config.mcpUrl = mcpUrl;
    store.setKV('mcp_url', mcpUrl);
    mcp.url = mcpUrl;
    mcp.connected = false;   // 触发重连
    applied.push('MCP 地址');
  }

  // 模型 Key（留空表示不修改）
  if (keys?.kimi) { PROVIDERS.kimi.apiKey = keys.kimi.trim(); store.setKV('kimi_key', PROVIDERS.kimi.apiKey); applied.push('Kimi Key'); }
  if (keys?.deepseek) { PROVIDERS.deepseek.apiKey = keys.deepseek.trim(); store.setKV('deepseek_key', PROVIDERS.deepseek.apiKey); applied.push('DeepSeek Key'); }

  // 模型名
  if (models?.kimi) { PROVIDERS.kimi.model = models.kimi.trim(); store.setKV('kimi_model', PROVIDERS.kimi.model); applied.push('Kimi 模型'); }
  if (models?.deepseek) { PROVIDERS.deepseek.model = models.deepseek.trim(); store.setKV('deepseek_model', PROVIDERS.deepseek.model); applied.push('DeepSeek 模型'); }

  // 当前使用的大模型
  if (provider) {
    if (!PROVIDERS[provider]) return res.status(400).json({ ok: false, error: '未知提供方' });
    settings.provider = provider;
    store.setKV('provider', provider);
    applied.push('当前模型');
  }

  // MCP 改了地址就立即重连验证
  let mcpOk = null;
  if (mcpUrl) {
    try { await ensureMcp(); mcpOk = true; } catch { mcpOk = false; }
  }

  res.json({ ok: true, applied, provider: settings.provider, mcpReconnected: mcpOk });
}));

// ── 启动：加载持久化设置（覆盖 .env 默认值）──
const savedProvider = store.getKV('provider');
if (savedProvider && PROVIDERS[savedProvider]) settings.provider = savedProvider;
const savedDevice = store.getKV('device_base_url');
if (savedDevice) config.deviceBaseUrl = savedDevice;
const savedProxy = store.getKV('device_proxy');
if (savedProxy !== null) config.deviceProxy = savedProxy || null;
const savedInterval = store.getKV('metrics_interval_ms');
if (savedInterval) config.metricsIntervalMs = Number(savedInterval);
const savedMcp = store.getKV('mcp_url');
if (savedMcp) config.mcpUrl = savedMcp;
for (const [kv, id, field] of [['kimi_key', 'kimi', 'apiKey'], ['deepseek_key', 'deepseek', 'apiKey'], ['kimi_model', 'kimi', 'model'], ['deepseek_model', 'deepseek', 'model']]) {
  const v = store.getKV(kv);
  if (v) PROVIDERS[id][field] = v;
}

startCollector();
ensureMcp().then(
  () => console.log(`[MCP] 已连接，${mcp.tools.length} 个工具: ${mcp.tools.map((t) => t.name).join(', ')}`),
  (e) => console.warn(`[MCP] 连接失败: ${e.message}（可在页面设置中配置后重连）`)
);

// 生产模式：后端直接托管前端静态文件（打包版无 Vite）
const webDist = path.join(__dirname, '..', 'web', 'dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log(`[ChargeAgent] 托管前端: ${webDist}`);
}

app.listen(config.backendPort, () => {
  console.log(`[ChargeAgent] 后端已启动: http://127.0.0.1:${config.backendPort}`);
});
