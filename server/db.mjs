// ── 文件存储（JSON/JSONL，零依赖，兼容 Electron 内置 Node）──
// 内存为主、磁盘持久化：samples 追加写 JSONL；会话与 KV 写 JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 打包模式：Electron 主进程通过环境变量指定可写数据目录（app.asar 内不可写）
const dataDir = process.env.CHARGEAGENT_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const samplesPath = path.join(dataDir, 'samples.jsonl');
const chatPath = path.join(dataDir, 'chat.json');
const kvPath = path.join(dataDir, 'kv.json');

// ── 采样：内存索引 + JSONL 追加 ──
let samples = []; // {ts,port,voltage_mv,current_ma,power_w,attached}
if (fs.existsSync(samplesPath)) {
  try {
    samples = fs.readFileSync(samplesPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { samples = []; }
}
// 存量清洗：历史滑动窗口重叠导致同一物理采样以不同 ts 重复入库。
// 按口排序后贪心重采样：与已保留样本间隔 <9s 的视为重叠副本丢弃（真实采样周期 10s）。
{
  const byPort = new Map();
  for (const r of samples) {
    if (!byPort.has(r.port)) byPort.set(r.port, []);
    byPort.get(r.port).push(r);
  }
  let kept = 0, before = samples.length;
  const resampled = [];
  for (const [port, arr] of byPort) {
    arr.sort((a, b) => a.ts - b.ts);
    let last = -1e15;
    for (const r of arr) {
      if (r.ts - last < 9000) continue; // 重叠窗口副本
      last = r.ts;
      resampled.push(r);
    }
  }
  resampled.sort((a, b) => a.ts - b.ts);
  kept = resampled.length;
  if (kept !== before) {
    samples = resampled;
    try { fs.writeFileSync(samplesPath, samples.map((r) => JSON.stringify(r)).join('\n') + (samples.length ? '\n' : '')); } catch {}
    console.log(`[db] 历史采样重采样：${before} → ${kept} 条（移除窗口重叠副本）`);
  }
}
let samplesDirtyCount = 0;

// ── 会话 / KV：整文件 JSON ──
let chat = { sessions: [], messages: {} };
if (fs.existsSync(chatPath)) {
  try { chat = JSON.parse(fs.readFileSync(chatPath, 'utf-8')); } catch { chat = { sessions: [], messages: {} }; }
}
let kv = {};
if (fs.existsSync(kvPath)) {
  try { kv = JSON.parse(fs.readFileSync(kvPath, 'utf-8')); } catch { kv = {}; }
}

let chatSaveTimer = null;
function scheduleChatSave() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try { fs.writeFileSync(chatPath, JSON.stringify(chat)); } catch {}
  }, 400);
}
function saveKV() {
  try { fs.writeFileSync(kvPath, JSON.stringify(kv)); } catch {}
}

export const store = {
  // 批量写入采样：立即追加 JSONL，内存与磁盘严格同步（无缓冲、无重写竞争）
  addSamples(rows) {
    if (!rows.length) return;
    samples.push(...rows);
    try { fs.appendFileSync(samplesPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); } catch {}
  },

  // 查询历史：某端口近 N 分钟（升序）
  getHistory(port, minutes = 60) {
    const since = Date.now() - minutes * 60_000;
    return samples.filter((r) => r.port === port && r.ts >= since);
  },

  purge(keepDays) {
    const cutoff = Date.now() - keepDays * 86_400_000;
    const before = samples.length;
    samples = samples.filter((r) => r.ts >= cutoff);
    const removed = before - samples.length;
    if (removed > 0) {
      // 重写文件，释放空间
      try { fs.writeFileSync(samplesPath, samples.map((r) => JSON.stringify(r)).join('\n') + (samples.length ? '\n' : '')); } catch {}
      samplesDirtyCount = 0;
    }
    // 会话也做上限
    if (chat.sessions.length > 50) {
      const drop = new Set(chat.sessions.slice(0, chat.sessions.length - 50).map((s) => s.id));
      chat.sessions = chat.sessions.slice(-50);
      for (const id of drop) delete chat.messages[id];
      scheduleChatSave();
    }
  },

  // ── 会话 ──
  createSession(id, title, provider, model) {
    const now = Date.now();
    chat.sessions.push({ id, title, provider, model, created_at: now, updated_at: now });
    chat.messages[id] = [];
    scheduleChatSave();
  },
  touchSession(id) {
    const s = chat.sessions.find((x) => x.id === id);
    if (s) { s.updated_at = Date.now(); scheduleChatSave(); }
  },
  listSessions() {
    return [...chat.sessions].sort((a, b) => b.updated_at - a.updated_at);
  },
  addMessage(sessionId, role, content, toolCalls = null, toolCallId = null) {
    if (!chat.messages[sessionId]) chat.messages[sessionId] = [];
    const arr = chat.messages[sessionId];
    arr.push({ id: arr.length + 1, session_id: sessionId, role, content, tool_calls: toolCalls ? JSON.stringify(toolCalls) : null, tool_call_id: toolCallId, ts: Date.now() });
    if (arr.length > 500) chat.messages[sessionId] = arr.slice(-500);
    scheduleChatSave();
  },
  getMessages(sessionId, limit = 200) {
    const arr = chat.messages[sessionId] || [];
    return arr.slice(-limit);
  },

  // ── KV 设置 ──
  getKV(key, fallback = null) {
    return key in kv ? kv[key] : fallback;
  },
  setKV(key, value) {
    kv[key] = String(value);
    saveKV();
  },

  // 进程退出前落盘（采样已实时追加，这里只管会话与 KV）
  flush() {
    try {
      fs.writeFileSync(chatPath, JSON.stringify(chat));
      fs.writeFileSync(kvPath, JSON.stringify(kv));
    } catch {}
  },
};

process.on('exit', () => store.flush());
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
process.on('SIGINT', () => { store.flush(); process.exit(0); });
