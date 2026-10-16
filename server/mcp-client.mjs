// ── 官方云端 MCP 客户端（SSE 传输，零依赖实现）──────────────
// 协议流程：GET SSE 拿到 message 端点 → POST JSON-RPC（initialize → tools/list → tools/call）
import { config } from './config.mjs';

export class McpClient {
  constructor(url = config.mcpUrl) {
    this.url = url;
    this.messageUrl = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.tools = [];
    this.connected = false;
    this._listeners = new Set();
  }

  onEvent(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(evt) { for (const fn of this._listeners) { try { fn(evt); } catch {} } }

  async connect(timeoutMs = 15000) {
    if (this.connected) return;
    // 单例在模块导入时就构造了，彼时持久化配置尚未加载；连接前总是同步最新地址
    if (config.mcpUrl && config.mcpUrl !== this.url) this.url = config.mcpUrl;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      this.sse = await fetch(this.url, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!this.sse.ok || !this.sse.body) throw new Error(`SSE HTTP ${this.sse.status}`);
      this._pump(this.sse.body);
      // 等 endpoint 事件
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等待 MCP endpoint 超时')), timeoutMs);
        const off = this.onEvent((evt) => {
          if (evt.type === 'endpoint') { clearTimeout(t); off(); resolve(); }
        });
      });
      await this._request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'charge-agent', version: '0.1.0' },
      });
      this._notify('notifications/initialized', {});
      const { tools } = await this._request('tools/list', {});
      this.tools = tools || [];
      this.connected = true;
    } finally {
      clearTimeout(timer);
    }
  }

  async _pump(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let event = 'message', data = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line) { // 空行 = 事件结束
            if (data) {
              if (event === 'endpoint') {
                this.messageUrl = new URL(data, this.url).toString();
                this._emit({ type: 'endpoint', url: this.messageUrl });
              } else {
                try {
                  const msg = JSON.parse(data);
                  this._dispatch(msg);
                } catch { /* 非 JSON 心跳等 */ }
              }
            }
            event = 'message'; data = '';
            continue;
          }
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
        }
      }
    } catch (e) {
      this.connected = false;
      this._emit({ type: 'error', error: String(e.message || e) });
    }  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    } else {
      this._emit({ type: 'notification', method: msg.method, params: msg.params });
    }
  }

  async _send(payload) {
    if (!this.messageUrl) throw new Error('MCP 未连接（缺少 message 端点）');
    const res = await fetch(this.messageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`MCP POST HTTP ${res.status}`);
    // 部分实现会直接在响应里返回结果
    const text = await res.text();
    if (text.trim()) {
      try {
        const msg = JSON.parse(text);
        if (msg && msg.id === payload.id) {
          if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
          return msg.result;
        }
      } catch (e) {
        if (e.message.startsWith('MCP POST')) throw e;
        // 非 JSON 或 id 不匹配 → 等待 SSE 回包
      }
    }
    return null;
  }

  _request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const direct = await this._send({ jsonrpc: '2.0', id, method, params });
        if (direct !== null) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(direct);
        }
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async _notify(method, params) {
    await this._send({ jsonrpc: '2.0', method, params });
  }

  // 调用工具，统一返回 { ok, resultText, isError, durationMs }
  async callTool(name, args = {}, timeoutMs = 45000) {
    const started = Date.now();
    try {
      const result = await this._request('tools/call', { name, arguments: args }, timeoutMs);
      const isError = !!result.isError;
      const texts = (result.content || [])
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`));
      const resultText = texts.join('\n');
      return { ok: !isError, resultText, isError, durationMs: Date.now() - started };
    } catch (e) {
      return { ok: false, resultText: String(e.message || e), isError: true, durationMs: Date.now() - started };
    }
  }

  toOpenAITools() {
    return this.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }
}

// 单例 + 自动重连（带健康检查：云端 SSE 单会话，掉线后自动重建）
export const mcp = new McpClient();

export async function ensureMcp() {
  if (mcp.connected) {
    try {
      await mcp._request('tools/list', {}, 8000);
      return mcp;
    } catch {
      mcp.connected = false;
    }
  }
  await mcp.connect();
  return mcp;
}
