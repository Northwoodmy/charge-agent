// ── 配置加载 + 双模型提供方注册 ──────────────────────────────
import dotenv from 'dotenv';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

export const config = {
  deviceBaseUrl: process.env.DEVICE_BASE_URL || 'http://192.168.8.68',
  mcpUrl: process.env.MCP_URL || '',
  backendPort: Number(process.env.BACKEND_PORT || 8932),
  metricsIntervalMs: Number(process.env.METRICS_INTERVAL_MS || 2000),
  historyIntervalMs: Number(process.env.HISTORY_INTERVAL_MS || 10000),
  historyKeepDays: Number(process.env.HISTORY_KEEP_DAYS || 7),
  // 设备访问兜底代理（Shadowrocket 类按应用 VPN 拦截直连时使用；直连正常时不走代理）
  deviceProxy: process.env.DEVICE_PROXY || 'http://127.0.0.1:1082',
};

// 提供方定义：页面设置页可切换
export const PROVIDERS = {
  kimi: {
    id: 'kimi',
    label: 'Kimi K2.8',
    baseURL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1',
    apiKey: process.env.KIMI_API_KEY || '',
    model: process.env.KIMI_MODEL || 'kimi-k2.8',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek V4 Pro',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  },
};

// 运行时设置（存 SQLite，支持页面切换默认提供方）
export const settings = {
  provider: process.env.DEFAULT_PROVIDER || 'kimi',
};

export function getProvider(id) {
  const p = PROVIDERS[id] || PROVIDERS[settings.provider] || PROVIDERS.kimi;
  return p;
}

export function makeClient(providerId) {
  const p = getProvider(providerId);
  if (!p.apiKey) throw new Error(`提供方 ${p.id} 未配置 API Key`);
  return { client: new OpenAI({ baseURL: p.baseURL, apiKey: p.apiKey }), provider: p };
}
