// ── Agent 对话循环：LLM tool-calling + MCP 执行 ─────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeClient, getProvider, settings } from './config.mjs';
import { ensureMcp, mcp } from './mcp-client.mjs';
import { store } from './db.mjs';
import { state } from './collector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf-8');

const MAX_TOOL_ROUNDS = 8;

function buildContext() {
  const p = state.processed;
  if (!p) return '（设备当前离线，无本地实时数据）';
  const lines = p.ports.map(
    (x) => `Port ${x.name}(${x.no}): ${x.attached ? `${x.powerW}W @ ${x.voltageV}V/${x.currentA}A, ${x.protocol}, 预算${x.budgetW}W, 已充${x.durationS}s/约${x.sessionWh}Wh` : '空口'}`
  );
  return `【本地实时快照 ${new Date(p.ts).toLocaleString('zh-CN')}】整机 ${p.totalW}W / 160W，活跃口 ${p.chargingPorts}/5\n${lines.join('\n')}`;
}

export async function chat({ sessionId, message, provider: providerOverride }) {
  const providerId = providerOverride || settings.provider;
  const provider = getProvider(providerId);
  const sid = sessionId || randomUUID();

  // 会话不存在则创建
  const existing = store.listSessions().find((s) => s.id === sid);
  if (!existing) {
    store.createSession(sid, message.slice(0, 30), provider.id, provider.model);
  }
  store.addMessage(sid, 'user', message);
  store.touchSession(sid);

  // 组装消息（带本地实时上下文）
  const history = store.getMessages(sid).filter((m) => m.role !== 'tool' || m.tool_call_id);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => {
      if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.content };
        if (m.tool_calls) msg.tool_calls = JSON.parse(m.tool_calls);
        return msg;
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      }
      return { role: 'user', content: m.content };
    }),
  ];

  // 注入实时上下文（放在 user 消息之后追加一条 system 上下文）
  messages.push({ role: 'system', content: buildContext() });

  let client;
  try {
    client = makeClient(providerId).client;
  } catch {
    return {
      sessionId: sid,
      reply: `${provider.label} 还没配置 API Key 🔑\n\n去右上角「⚙ 设置」里填写 ${provider.id === 'kimi' ? 'Kimi' : 'DeepSeek'} 的 Key，保存后我就能干活了。`,
      toolLog: [],
      provider: { id: provider.id, label: provider.label, model: provider.model },
      mcpConnected: mcp.connected,
    };
  }
  console.log(`[Agent] 使用模型: ${provider.model} @ ${provider.baseURL}（密钥长度 ${provider.apiKey.length}）`);
  await ensureMcp().catch(() => null); // MCP 连不上也允许纯文本回答
  const tools = mcp.connected ? mcp.toOpenAITools() : [];

  const toolLog = [];
  let finalText = '';
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const resp = await client.chat.completions.create({
      model: provider.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      max_tokens: 4096,
    });
    const choice = resp.choices[0];
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        toolLog.push({ name: tc.function.name, args, ts: Date.now() });
        let outcome;
        if (mcp.connected) {
          outcome = await mcp.callTool(tc.function.name, args);
        } else {
          outcome = { ok: false, resultText: 'MCP 未连接，无法执行工具', isError: true };
        }
        toolLog[toolLog.length - 1].result = outcome.resultText?.slice(0, 2000);
        toolLog[toolLog.length - 1].ok = outcome.ok;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: outcome.resultText || '(empty)',
        });
      }
      continue;
    }

    finalText = msg.content || '';
    break;
  }

  store.addMessage(sid, 'assistant', finalText, toolLog.length ? toolLog : null);

  return {
    sessionId: sid,
    reply: finalText,
    toolLog,
    provider: { id: provider.id, label: provider.label, model: provider.model },
    mcpConnected: mcp.connected,
  };
}

// 确定性控制：页面按钮直接调 MCP（不过 LLM）
const CONTROL_TOOLS = new Set([
  'turn_on_port', 'turn_off_port', 'set_charging_strategy', 'set_usba_charging_mode',
  'set_temperature_mode', 'set_port_power_allocation', 'set_display_intensity',
  'set_status_display_mode', 'set_idle_display', 'set_hourly_chime',
]);

// 只读查询：页面展示当前策略/温控/亮度等
const READ_TOOLS = new Set([
  'get_charging_status', 'get_device_info', 'get_machine_facts', 'get_port_details',
  'get_port_pd_status', 'get_temperature_mode', 'get_display_config', 'get_port_stats',
]);

export async function directQuery(tool, args) {
  if (!READ_TOOLS.has(tool)) {
    return { ok: false, error: `不允许的查询工具: ${tool}` };
  }
  await ensureMcp();
  const outcome = await mcp.callTool(tool, args || {});
  return { ok: outcome.ok, result: outcome.resultText };
}

export async function directControl(tool, args) {
  if (!CONTROL_TOOLS.has(tool)) {
    return { ok: false, error: `不允许直接调用工具: ${tool}（控制类白名单外）` };
  }
  await ensureMcp();
  const outcome = await mcp.callTool(tool, args || {});
  // 端口控制后回读确认
  let confirm = null;
  if (tool === 'turn_on_port' || tool === 'turn_off_port') {
    confirm = await mcp.callTool('get_charging_status', {});
  }
  return { ok: outcome.ok, result: outcome.resultText, confirm: confirm?.resultText || null };
}
