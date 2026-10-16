// 统一 API 访问层
async function req(path, opts) {
  const res = await fetch(path, opts ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  status: () => req('/api/status'),
  history: (port, minutes = 60) => req(`/api/history?port=${port}&minutes=${minutes}`),
  stats: () => req('/api/stats'),
  events: (since = 0) => req(`/api/events?since=${since}`),
  live: (seconds = 600) => req(`/api/live?seconds=${seconds}`),
  mcpStatus: () => req('/api/mcp/status'),
  mcpReconnect: () => req('/api/mcp/reconnect', {}),
  control: (tool, args) => req('/api/control', { tool, args }),
  query: (tool, args) => req('/api/mcp/query', { tool, args }),
  chat: (payload) => req('/api/agent/chat', payload),
  sessions: () => req('/api/agent/sessions'),
  sessionMessages: (id) => req(`/api/agent/sessions/${id}/messages`),
  settings: () => req('/api/settings'),
  saveSettings: (payload) => req('/api/settings', payload),
};
