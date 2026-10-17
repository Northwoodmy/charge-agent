import React from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import PowerChart, { PORT_COLORS } from './PowerChart.jsx';
import { VERSION } from './version.js';

const fmtDur = (s) => {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}时${m}分` : `${m}分`;
};

function Header({ status, mcp, onOpenSettings }) {
  const sys = status?.data?.system;
  const online = status?.online;
  return (
    <div className="header">
      <div className="brand">
        <img src="/brand/xiaodianpin.png" alt="小电拼" className="wordmark" onError={(e) => { e.currentTarget.outerHTML = '<b style="font-size:17px">小电拼</b>'; }} />
      </div>
      <div>
        <h1>充电管家</h1>
        <div className="sub">
          <span className={`dot ${online ? '' : 'off'}`}></span>
          {online ? '在线' : `离线${status?.lastError ? ' · ' + status.lastError : ''}`}
          {sys && <> · 已运行 {fmtDur(sys.boot_time_seconds)}</>}
        </div>
      </div>
      <div className="spacer" />
      {mcp && (
        <span className={`chip ${mcp.connected ? 'red' : ''}`} title="官方云端 MCP 连接状态">
          ● MCP
        </span>
      )}
      <button className="chip btn-icon" onClick={onOpenSettings} title="设置">⚙ 设置</button>
    </div>
  );
}

// ── 设置弹窗：设备地址 / 大模型 / MCP ──
function SettingsModal({ open, onClose, settings, onSaved }) {
  const [form, setForm] = React.useState({});
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState('');

  React.useEffect(() => {
    if (open && settings) {
      setForm({
        deviceBaseUrl: settings.deviceBaseUrl || '',
        deviceProxy: settings.deviceProxy || '',
        metricsIntervalMs: settings.metricsIntervalMs || 500,
        mcpUrl: settings.mcpUrl || '',
        provider: settings.provider || 'kimi',
        kimiKey: '', kimiModel: settings.providers?.find((p) => p.id === 'kimi')?.model || '',
        deepseekKey: '', deepseekModel: settings.providers?.find((p) => p.id === 'deepseek')?.model || '',
      });
      setMsg('');
    }
  }, [open, settings]);

  if (!open) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const kimiInfo = settings?.providers?.find((p) => p.id === 'kimi');
  const dsInfo = settings?.providers?.find((p) => p.id === 'deepseek');

  const save = async () => {
    setSaving(true);
    setMsg('保存中…');
    try {
      const r = await api.saveSettings({
        deviceBaseUrl: form.deviceBaseUrl?.trim(),
        deviceProxy: form.deviceProxy?.trim(),
        metricsIntervalMs: Number(form.metricsIntervalMs) || 500,
        mcpUrl: form.mcpUrl?.trim(),
        provider: form.provider,
        keys: { kimi: form.kimiKey?.trim(), deepseek: form.deepseekKey?.trim() },
        models: { kimi: form.kimiModel?.trim(), deepseek: form.deepseekModel?.trim() },
      });
      if (r.ok) {
        let m = `已保存：${r.applied?.join('、') || '无变更'}`;
        if (r.mcpReconnected === true) m += ' · MCP 重连成功';
        if (r.mcpReconnected === false) m += ' · ⚠ MCP 重连失败，请检查地址';
        setMsg(m);
        onSaved?.();
        setTimeout(() => onClose(), 1200);
      } else {
        setMsg(`保存失败：${r.error}`);
      }
    } catch (e) {
      setMsg(`保存失败：${e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="form-group">
          <h3>小电拼设备</h3>
          <label>设备局域网地址（换一台小电拼就改这里）</label>
          <input value={form.deviceBaseUrl || ''} onChange={(e) => set('deviceBaseUrl', e.target.value)}
            placeholder="http://192.168.8.68" />
          <label>兜底代理（可选：直连被 VPN/代理软件拦截时自动改走这里）</label>
          <input value={form.deviceProxy || ''} onChange={(e) => set('deviceProxy', e.target.value)}
            placeholder="http://127.0.0.1:1082，留空关闭" />
          <label>数据刷新速率（页面数字与曲线的实时性）</label>
          <select value={form.metricsIntervalMs || 500} onChange={(e) => set('metricsIntervalMs', Number(e.target.value))}>
            <option value={250}>极速 · 250ms</option>
            <option value={500}>流畅 · 500ms（默认）</option>
            <option value={1000}>均衡 · 1 秒</option>
            <option value={2000}>省电 · 2 秒</option>
            <option value={5000}>静默 · 5 秒</option>
          </select>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>提示：250ms 会对小电拼的 Wi-Fi 模块产生持续压力，非必要不建议长期使用</label>
        </div>

        <div className="form-group">
          <h3>官方云端 MCP</h3>
          <label>MCP 服务器地址（含设备 PSN 与 token，官方应用里获取）</label>
          <input value={form.mcpUrl || ''} onChange={(e) => set('mcpUrl', e.target.value)}
            placeholder="https://mcp.thecandysign.com/<psn>/<token>/sse" />
        </div>

        <div className="form-group">
          <h3>大模型</h3>
          <label>当前使用</label>
          <select value={form.provider || 'kimi'} onChange={(e) => set('provider', e.target.value)}>
            <option value="kimi">Kimi K2.8</option>
            <option value="deepseek">DeepSeek</option>
          </select>
          <label>Kimi API Key（{kimiInfo?.hasKey ? `已配置 ${kimiInfo.maskedKey}` : '未配置'}，留空不修改）</label>
          <input value={form.kimiKey || ''} onChange={(e) => set('kimiKey', e.target.value)}
            placeholder={kimiInfo?.hasKey ? '已配置，输入新 Key 可替换' : 'sk-kimi-...'} />
          <label>Kimi 模型名</label>
          <input value={form.kimiModel || ''} onChange={(e) => set('kimiModel', e.target.value)} placeholder="kimi-k2.8" />
          <label>DeepSeek API Key（{dsInfo?.hasKey ? `已配置 ${dsInfo.maskedKey}` : '未配置'}，留空不修改）</label>
          <input value={form.deepseekKey || ''} onChange={(e) => set('deepseekKey', e.target.value)}
            placeholder={dsInfo?.hasKey ? '已配置，输入新 Key 可替换' : 'sk-...'} />
          <label>DeepSeek 模型名</label>
          <input value={form.deepseekModel || ''} onChange={(e) => set('deepseekModel', e.target.value)} placeholder="deepseek-v4-pro" />
        </div>

        {msg && <div className="form-msg">{msg}</div>}
        <div className="form-actions">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

function Overview({ status }) {
  const d = status?.data;
  if (!d) return null;
  const pct = Math.min(100, (d.totalW / d.budgetTotalW) * 100);
  const sorted = d.ports.slice().sort((a, b) => (a.type === 'A') - (b.type === 'A'));
  return (
    <div className="overview">
      <div className="big-power">
        <div className="num">{d.totalW}<small> W</small></div>
        <div className="label">整机实时输出 · 活跃 {d.chargingPorts}/5 口</div>
      </div>
      <div className="pool">
        {/* 总进度条 */}
        <div className="bar-row total">
          <span className="bar-name">整机</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${pct}%`, background: 'var(--ink)' }} />
          </div>
          <span className="bar-val">{d.totalW} / {d.budgetTotalW}W</span>
        </div>
        {/* 每个端口一条进度条，按自己的功率档位计 */}
        {sorted.map((p) => {
          const cap = p.budgetW || 140;
          const fill = p.attached ? Math.min(100, (p.powerW / cap) * 100) : 0;
          return (
            <div key={p.idx} className={`bar-row ${p.attached ? '' : 'idle'}`}>
              <span className="bar-name">{p.name}</span>
              <div className="bar-track slim">
                <div className="bar-fill" style={{ width: `${fill}%`, background: PORT_COLORS[p.idx] }} />
              </div>
              <span className="bar-val">{p.attached ? `${p.powerW} / ${cap}W` : '空闲'}</span>
            </div>
          );
        })}
        <div className="pool-cap"><span>FluxAI 自由流® · 整机功率智能调度</span></div>
      </div>
    </div>
  );
}

// PD 设备温度档位翻译
function fmtTempC(t) {
  return { cool: '凉爽', moderate: '适中', warm: '偏热' }[t] || null;
}

// PD 电池信息格式化：65535(0xFFFF) 是协议"未知"哨兵，决不当真值显示
function fmtBatt(pd) {
  if (!pd?.battery_present || pd.battery_invalid) return null;
  const UNKNOWN = 65535;
  const present = pd.battery_present_capacity;
  const design = pd.battery_design_capacity;
  // 分母优先用「实际满充容量」（电池衰减后的真 100% 基准），无效时回退设计容量
  const full = (pd.battery_last_full_charge_capacity > 0 && pd.battery_last_full_charge_capacity !== UNKNOWN)
    ? pd.battery_last_full_charge_capacity : design;
  if (full > 0 && full !== UNKNOWN) {
    if (present === UNKNOWN || !(present > 0)) return null; // 有基准但当前电量未知
    return `电量 ${Math.min(100, Math.round((present / full) * 100))}%`;
  }
  if (present > 0 && present !== UNKNOWN) return `电池 ${(present / 10).toFixed(1)}Wh`;
  return null; // 只报"有电池"不报数值（如 Redmi K80 系列）
}

function PortCard({ port, onToggle, pdInfo }) {
  const [busy, setBusy] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await onToggle(port);
    } finally { setBusy(false); }
  };
  // 端口状态：已关闭(!active) / 充电中(attached) / 空闲(启用但无设备)
  const closed = !port.active;
  return (
    <div className={`port-card ${port.attached ? 'charging' : ''} ${closed ? 'closed' : ''}`}>
      <div className="port-head">
        <span className="port-name">{port.name}<span className="type">· USB-{port.type}</span></span>
        <span className="port-head-right">
          {port.attached ? (
            <button className="port-info-btn" title="查看 PD 协商与线材详情" onClick={() => setShowDetail(true)}>i</button>
          ) : (
            <span className="port-info-btn off" title="插入设备后可查看详情">i</span>
          )}
          <span className={`badge ${port.attached ? 'on' : ''} ${closed ? 'closed' : ''}`}>
            {closed ? '已关闭' : port.attached ? '充电中' : '空闲'}
          </span>
        </span>
      </div>
      <div className="port-power">{port.powerW}<small> W</small></div>
      <div className="port-vals">
        <span><b>{port.voltageV.toFixed(1)}</b> V</span>
        <span><b>{port.currentA.toFixed(2)}</b> A</span>
        <span>预算 <b>{port.budgetW}</b> W</span>
      </div>
      <div className="port-meta">
        {port.attached ? (
          <>
            {pdInfo?.device_name_zh && <span className="port-device">{pdInfo.device_name_zh}</span>}
            {fmtBatt(pdInfo) && <span className="port-batt">{fmtBatt(pdInfo)}</span>}
            {fmtTempC(pdInfo?.status_temperature) && <span>{fmtTempC(pdInfo.status_temperature)}</span>}
            <span>{port.protocol}</span>
            <span>已充 {fmtDur(port.durationS)}</span>
            <span>≈{(pdInfo?.session_charge_mwh > 0 ? pdInfo.session_charge_mwh / 1000 : port.sessionWh).toFixed(1)}Wh</span>
          </>
        ) : (
          <span>{closed ? '端口已关闭 · 不输出电力' : '已就绪 · 插入设备即充'}</span>
        )}
      </div>
      {port.active ? (
        <button
          className={`port-toggle ${port.attached ? 'danger' : ''}`}
          disabled={busy}
          onClick={toggle}
          title={port.attached ? '物理切断该口输出（等效拔线），设备会立即断电' : '关闭该口输出，插设备也不会充电'}
        >
          {busy ? '执行中…' : `关闭 ${port.name} 端口`}
        </button>
      ) : (
        <button
          className="port-toggle"
          disabled={busy}
          onClick={toggle}
          title="重新启用该口并恢复供电"
        >
          {busy ? '执行中…' : `开启 ${port.name} 端口`}
        </button>
      )}
      {showDetail && <PortDetailModal port={port} onClose={() => setShowDetail(false)} />}
    </div>
  );
}

// ── 端口详情弹层：PD 协商 + 线材信息 + 设备端历史 ──
function PortDetailModal({ port, onClose }) {
  const [pd, setPd] = React.useState(null);
  const [stats, setStats] = React.useState(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    Promise.all([
      api.query('get_port_pd_status', {}).catch(() => null),
      api.query('get_port_stats', { port: port.no }).catch(() => null),
    ]).then(([pdRes, stRes]) => {
      try {
        const all = JSON.parse(pdRes?.result || 'null');
        setPd(all?.ports?.find((x) => x.port === port.no) || null);
      } catch { setPd(null); }
      try {
        setStats(JSON.parse(stRes?.result || 'null'));
      } catch { setStats(null); }
    }).catch((e) => setErr(String(e.message || e)));
  }, [port.no]);

  // 设备端历史 sparkline
  const samples = stats?.samples || [];
  const pts = samples.map((s) => s.power_mw / 1000);
  const max = Math.max(...pts, 1);
  const W = 440, H = 60;
  const path = pts.length > 1
    ? pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - (v / max) * (H - 6)}`).join(' ')
    : '';

  // 用 portal 挂到 body：端口卡 hover 时的 transform 会让 fixed 定位失真
  return createPortal(
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{port.name} 口详情</h2>
        {pd?.device_name_zh && (
          <div className="detail-device">{pd.device_brand_zh && pd.device_brand_zh !== pd.device_name_zh ? `${pd.device_brand_zh} · ` : ''}{pd.device_name_zh}</div>
        )}
        {err && <div className="form-msg">读取失败：{err}</div>}
        {!pd && !err && <div className="form-msg">读取中…</div>}
        {pd && !pd.cable_brand_zh && !pd.pd_revision && (
          <div className="form-msg">该口未连接设备，暂无协商数据</div>
        )}
        {pd && (pd.pd_revision || pd.cable_brand_zh) && (
          <>
            <div className="detail-group">
              <h3>充电协商</h3>
              <table className="detail-table">
                <tbody>
                  <tr><td>PD 版本</td><td>{pd.pd_revision || '—'}</td></tr>
                  <tr><td>当前工作点</td><td>{pd.operating_voltage ? `${pd.operating_voltage / 1000}V · ${pd.operating_current}mA` : '—'}</td></tr>
                  {pd.sink_maximum_pdp > 0 && <tr><td>设备需求功率</td><td>峰值 {pd.sink_maximum_pdp}W · 典型 {pd.sink_operational_pdp}W</td></tr>}
                  <tr><td>PPS 快充</td><td>{pd.pps_charging_supported ? '支持' : '不支持'}</td></tr>
                  {fmtBatt(pd) && (
                    <tr><td>设备电池</td><td>{fmtBatt(pd)}（{{0: '充电中', 1: '放电', 2: '已充满'}[pd.battery_status] || '静置'}）</td></tr>
                  )}
                  {fmtTempC(pd.status_temperature) && (
                    <tr><td>设备温度</td><td>{fmtTempC(pd.status_temperature)}</td></tr>
                  )}
                  {(() => {
                    if (!pd.battery_present || pd.battery_invalid) return null;
                    const U = 65535;
                    const rows = [];
                    const d = pd.battery_design_capacity, f = pd.battery_last_full_charge_capacity;
                    if (d > 0 && d !== U && f > 0 && f !== U) {
                      const ratio = Math.min(100, (f / d) * 100);
                      const health = ratio.toFixed(1);
                      const loss = ((d - f) / 10).toFixed(1);
                      rows.push(
                        <tr key="h"><td>电池健康</td><td>{health}%（{ratio < 100 ? `衰减 ${(100 - ratio).toFixed(1)}%，损失 ${loss}Wh` : '无衰减'}）</td></tr>
                      );
                    }
                    const parts = [];
                    const cur = pd.battery_present_capacity;
                    if (cur > 0 && cur !== U) parts.push(`当前 ${(cur / 10).toFixed(1)}Wh`);
                    if (f > 0 && f !== U) parts.push(`满充 ${(f / 10).toFixed(1)}Wh`);
                    if (d > 0 && d !== U) parts.push(`设计 ${(d / 10).toFixed(1)}Wh`);
                    if (parts.length) {
                      rows.push(<tr key="c"><td>电池容量</td><td>{parts.join(' · ')}</td></tr>);
                    }
                    return rows.length ? <>{rows}</> : null;
                  })()}
                </tbody>
              </table>
            </div>
            <div className="detail-group">
              <h3>线材</h3>
              <table className="detail-table">
                <tbody>
                  <tr><td>品牌</td><td>{pd.cable_brand_zh || '未知'}</td></tr>
                  <tr><td>E-Marker 芯片</td><td>{pd.has_emarker ? '有（正规快充线）' : '无'}</td></tr>
                  <tr><td>数据速率</td><td>{pd.cable_usb_highest_speed || '—'}</td></tr>
                  <tr><td>EPR（48V）能力</td><td>{pd.cable_epr_mode_capable ? '支持' : '不支持'}</td></tr>
                </tbody>
              </table>
            </div>
          </>
        )}
        {samples.length > 0 && (
          <div className="detail-group">
            <h3>设备端历史（{stats.count} 个采样 · 功率 W）</h3>
            <svg viewBox={`0 0 ${W} ${H}`} className="detail-spark">
              <polyline points={path} fill="none" stroke="var(--red)" strokeWidth="1.5" />
            </svg>
          </div>
        )}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// 把 MCP 返回的 JSON 文本翻译成用户看得懂的话
function fmtTemp(raw) {
  try {
    const d = JSON.parse(raw);
    return d.mode === 1
      ? '当前：温度优先 · 优先控制发热，充电稍保守'
      : '当前：功率优先 · 跑满性能，机身会偏热';
  } catch { return '当前：读取失败'; }
}
function fmtDisplay(raw) {
  try {
    const d = JSON.parse(raw);
    const bright = { '关': '屏幕已关闭', '低': '亮度：低', '中': '亮度：中', '高': '亮度：高' }[d.level] || `亮度：${d.level}`;
    const mode = d.display_mode === '功率显示优先' ? '平时显示实时功率' : '平时循环动画';
    const idle = { '流星': '待机画面流星', '落花': '待机画面落花', '康威的生命游戏': '待机画面生命游戏', '时间': '待机画面时钟' }[d.idle_display] || `待机画面：${d.idle_display}`;
    const chime = d.hourly_chime ? '整点会闪屏报时' : '整点不打扰';
    return `当前：${bright} · ${mode} · ${idle} · ${chime}`;
  } catch { return '当前：读取失败'; }
}

function ControlPanel() {
  const [info, setInfo] = React.useState({});
  const [flash, setFlash] = React.useState('');

  const refresh = React.useCallback(async () => {
    const [temp, disp, det] = await Promise.all([
      api.query('get_temperature_mode', {}).catch(() => null),
      api.query('get_display_config', {}).catch(() => null),
      api.query('get_port_details', {}).catch(() => null),
    ]);
    let dieTemps = null;
    try {
      const all = JSON.parse(det?.result || 'null');
      if (all?.ports?.length) {
        dieTemps = {};
        for (const p of all.ports) dieTemps[p.port] = p.die_temperature;
      }
    } catch {}
    setInfo({ temp: temp?.result, disp: disp?.result, dieTemps });
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);
  // 15 秒自动重试：MCP 连接恢复后能自动读出当前值，不再卡在「读取中」
  React.useEffect(() => {
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (label, fn) => {
    setFlash(`执行中：${label}…`);
    const r = await fn();
    setFlash(r.ok ? `✓ ${label} 已执行` : `✗ ${label} 失败：${r.error || r.result || '未知错误'}`);
    setTimeout(() => setFlash(''), 4000);
    refresh();
  };

  // 解析当前值，用于按钮高亮
  let tempMode = null, level = null, dispMode = null, idleDisp = null, chime = null;
  try { tempMode = JSON.parse(info.temp || 'null')?.mode; } catch {}
  try {
    const d = JSON.parse(info.disp || 'null');
    level = d?.level; dispMode = d?.display_mode; idleDisp = d?.idle_display; chime = d?.hourly_chime;
  } catch {}

  return (
    <div className="section">
      <h2>温控与屏幕</h2>
      <div className="hint">设置直接下发到设备（不经 AI），状态实时回读——高亮的按钮就是设备当前的真值。</div>
      <div className="ctrl-grid">
        <div className="ctrl-group">
          <h3>温控模式</h3>
          <div className="btn-row">
            <button className={`btn sm ghost ${tempMode === 0 ? 'active' : ''}`} onClick={() => act('功率优先', () => api.control('set_temperature_mode', { mode: 0 }))}>功率优先</button>
            <button className={`btn sm ghost ${tempMode === 1 ? 'active' : ''}`} onClick={() => act('温度优先', () => api.control('set_temperature_mode', { mode: 1 }))}>温度优先</button>
          </div>
          <div className="ctrl-status">{info.temp ? fmtTemp(info.temp) : '读取中…'}</div>
          {info.dieTemps && (
            <div className="chip-temps">
              <div className="chip-temps-label">各口芯片温度</div>
              <div className="chip-temps-row">
                {[[2, 'C1'], [3, 'C2'], [4, 'C3'], [5, 'C4'], [1, 'A']].map(([no, name]) => {
                  const t = info.dieTemps[no];
                  const cls = { cool: 'cool', moderate: 'mid', warm: 'hot' }[t] || 'idle';
                  return (
                    <div key={no} className="chip-temp" title="SW3566 功率芯片温度">
                      <span className={`chip-dot ${cls}`} />
                      <span className="chip-name">{name}</span>
                      <span className="chip-val">{fmtTempC(t) || '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="ctrl-group">
          <h3>状态屏</h3>
          <div className="ctrl-row">
            <span className="ctrl-row-label">亮度</span>
            <div className="btn-row">
              {['关', '低', '中', '高'].map((lv) => (
                <button key={lv} className={`btn sm ghost ${level === lv ? 'active' : ''}`} onClick={() => act(`屏幕亮度「${lv}」`, () => api.control('set_display_intensity', { level: lv }))}>{lv}</button>
              ))}
            </div>
          </div>
          <div className="ctrl-row">
            <span className="ctrl-row-label">平时显示</span>
            <div className="btn-row">
              {['待机动画优先', '功率显示优先'].map((m) => (
                <button key={m} className={`btn sm ghost ${dispMode === m ? 'active' : ''}`} onClick={() => act(`屏显模式「${m}」`, () => api.control('set_status_display_mode', { mode: m }))}>{m === '功率显示优先' ? '实时功率' : '循环动画'}</button>
              ))}
            </div>
          </div>
          <div className="ctrl-row">
            <span className="ctrl-row-label">待机画面</span>
            <div className="btn-row">
              {['流星', '落花', '康威的生命游戏', '时间'].map((s) => (
                <button key={s} className={`btn sm ghost ${idleDisp === s ? 'active' : ''}`} onClick={() => act(`待机显示「${s}」`, () => api.control('set_idle_display', { idle_display: s }))}>{s === '康威的生命游戏' ? '生命游戏' : s}</button>
              ))}
            </div>
          </div>
          <div className="ctrl-row">
            <span className="ctrl-row-label">整点报时</span>
            <div className="btn-row">
              <button className={`btn sm ghost ${chime === true ? 'active' : ''}`} onClick={() => act('打开整点报时', () => api.control('set_hourly_chime', { enabled: true }))}>开启</button>
              <button className={`btn sm ghost ${chime === false ? 'active' : ''}`} onClick={() => act('关闭整点报时', () => api.control('set_hourly_chime', { enabled: false }))}>关闭</button>
            </div>
          </div>
          <div className="ctrl-status">{info.disp ? fmtDisplay(info.disp) : '读取中…'}</div>
        </div>
      </div>
      {flash && <div className="ctrl-status" style={{ marginTop: 12 }}>{flash}</div>}
    </div>
  );
}

function AgentConsole({ settings }) {
  const [sessionId, setSessionId] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const logRef = React.useRef(null);

  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: text, ts: Date.now() }]);
    try {
      const r = await api.chat({ sessionId, message: text, provider: settings?.provider });
      setSessionId(r.sessionId);
      setMessages((m) => [...m, { role: 'assistant', content: r.reply, toolLog: r.toolLog, provider: r.provider, ts: Date.now() }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `出错了：${e.message}`, ts: Date.now() }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="section">
      <h2>Agent 控制台</h2>
      <div className="hint">
        用自然语言查询或控制小电拼，例如：「C3 为什么只有 7W」「切到魔拟充」「把 C2 设成 100W」。
        {settings && <> 当前模型：<b>{settings.providers.find((p) => p.id === settings.provider)?.label}</b></>}
      </div>
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="msg assistant">你好，我是小电拼的充电管家 ⚡ 随时问我充电状态，或者让我帮你调策略、改功率、关端口。</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' && m.provider && (
              <div className="meta">{m.provider.label} · {new Date(m.ts).toLocaleTimeString('zh-CN')}</div>
            )}
            {m.content}
            {m.toolLog?.length > 0 && (
              <details className="tool-log">
                <summary>🔧 {m.toolLog.length} 次工具调用</summary>
                <pre>{JSON.stringify(m.toolLog, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant">思考中…（工具调用可能要几秒）</div>}
      </div>
      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="问点什么，或下指令…"
          disabled={busy}
        />
        <button className="btn" onClick={send} disabled={busy || !input.trim()}>发送</button>
      </div>
    </div>
  );
}

function ChartSection() {
  const [mode, setMode] = React.useState('live'); // 'live' | 分钟数
  const [hidden, setHidden] = React.useState(new Set());
  const [raw, setRaw] = React.useState([]);
  const [portNames] = React.useState(['A', 'C1', 'C2', 'C3', 'C4']);

  const load = React.useCallback(async () => {
    if (mode === 'live') {
      const r = await api.live(600);
      setRaw((r.ports || []).map((p) => p.points));
    } else {
      const all = await Promise.all([0, 1, 2, 3, 4].map((p) => api.history(p, mode)));
      setRaw(all.map((r) => (r.samples || []).map((s) => [s.ts, s.power_w])));
    }
  }, [mode]);

  React.useEffect(() => {
    load();
    const t = setInterval(load, mode === 'live' ? 2000 : 10000);
    return () => clearInterval(t);
  }, [load, mode]);

  const series = raw
    .map((points, port) => ({
      port, name: portNames[port], color: PORT_COLORS[port],
      points: points.map(([ts, w]) => [Math.floor(ts / 1000), w]),
    }))
    .filter((s) => !hidden.has(s.port) && s.points.length > 1);

  return (
    <div className="section">
      <h2>功率曲线</h2>
      <div className="hint">
        <a href="#" style={{ color: mode === 'live' ? 'var(--red)' : 'inherit', fontWeight: mode === 'live' ? 700 : 400 }}
          onClick={(e) => { e.preventDefault(); setMode('live'); }}>⚡ 实时滚动</a>
        <span style={{ margin: '0 6px', color: 'var(--muted)' }}>·</span>
        历史：
        {[30, 60, 180, 720].map((m) => (
          <a key={m} href="#" style={{ marginLeft: 8, color: mode === m ? 'var(--red)' : 'inherit' }}
            onClick={(e) => { e.preventDefault(); setMode(m); }}>{m < 60 ? `${m}分钟` : `${m / 60}小时`}</a>
        ))}
        <span style={{ marginLeft: 10 }}>
          {mode === 'live' ? '500ms 采样 · 每 2 秒滚动' : '10 秒采样 · 本地保留 7 天'}
        </span>
      </div>
      <div className="chart-legend">
        {portNames.map((n, i) => (
          <label key={n}>
            <input type="checkbox" checked={!hidden.has(i)} onChange={() => {
              const next = new Set(hidden);
              next.has(i) ? next.delete(i) : next.add(i);
              setHidden(next);
            }} />
            <span className="legend-swatch" style={{ background: PORT_COLORS[i] }} />{n}
          </label>
        ))}
      </div>
      <PowerChart series={series} />
    </div>
  );
}

function StatsBar({ status }) {
  const [stats, setStats] = React.useState(null);
  React.useEffect(() => {
    const load = () => api.stats().then(setStats).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  const d = status?.data;
  return (
    <div className="section">
      <h2>今日统计</h2>
      <div className="stats">
        <div className="stat-box"><div className="v">{stats ? stats.todayWh : '—'}<small style={{ fontSize: 13, color: 'var(--muted)' }}> Wh</small></div><div className="k">今日累计输出</div></div>
        <div className="stat-box"><div className="v">{d ? d.chargingPorts : '—'}<small style={{ fontSize: 13, color: 'var(--muted)' }}> / 5</small></div><div className="k">当前活跃端口</div></div>
        <div className="stat-box"><div className="v">{d ? d.totalW : '—'}<small style={{ fontSize: 13, color: 'var(--muted)' }}> W</small></div><div className="k">整机实时功率</div></div>
        <div className="stat-box"><div className="v">{d ? Math.max(0, Math.round((1 - d.totalW / d.budgetTotalW) * 100)) : '—'}<small style={{ fontSize: 13, color: 'var(--muted)' }}> %</small></div><div className="k">共享池余量</div></div>
      </div>
    </div>
  );
}

function SystemDrawer({ status }) {
  const sys = status?.data?.system;
  const [net, setNet] = React.useState(null);
  React.useEffect(() => {
    api.query('get_device_info', {}).then((r) => {
      try { setNet(JSON.parse(r?.result || 'null')); } catch { setNet(null); }
    }).catch(() => {});
  }, []);
  if (!sys) return null;
  const rssiText = net?.rssi != null ? `${net.rssi} dBm（${net.rssi > -60 ? '良好' : net.rssi > -70 ? '一般' : '偏弱'}）` : null;
  return (
    <details className="system">
      <summary>系统细节（芯片 / 内存 / 网络）</summary>
      <div className="body">
        <table>
          <tbody>
            <tr><td>芯片</td><td>{sys.chip} · {sys.cores} 核 @{sys.cpu_freq_mhz}MHz</td></tr>
            <tr><td>IDF</td><td>{sys.idf_version}</td></tr>
            <tr><td>固件</td><td>{sys.app_version}（启动原因码 {sys.reset_reason}）</td></tr>
            <tr><td>空闲堆内存</td><td>{(sys.free_heap / 1024).toFixed(1)} KB</td></tr>
            {net && <tr><td>Wi-Fi 网络</td><td>{net.ssid || '—'}</td></tr>}
            {rssiText && <tr><td>信号强度</td><td>{rssiText}</td></tr>}
            {net?.psn && <tr><td>设备 PSN</td><td>{net.psn}</td></tr>}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function FullApp() {
  const [status, setStatus] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [mcp, setMcp] = React.useState(null);
  const [pollMs, setPollMs] = React.useState(2000);

  React.useEffect(() => {
    api.status().then((s) => {
      setStatus(s);
      // 轮询节奏跟随后端配置（.env 的 METRICS_INTERVAL_MS）
      fetch('/api/config').then((r) => r.json()).then((c) => {
        if (c.metricsIntervalMs) setPollMs(Math.max(250, c.metricsIntervalMs));
      }).catch(() => {});
    }).catch(() => {});
    const t = setInterval(() => api.status().then(setStatus).catch(() => {}), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  React.useEffect(() => {
    const load = () => api.settings().then(setSettings).catch(() => {});
    load();
    const t = setInterval(() => api.mcpStatus().then(setMcp).catch(() => {}), 10000);
    api.mcpStatus().then(setMcp).catch(() => {});
    return () => clearInterval(t);
  }, []);

  const togglePort = async (port) => {
    const tool = port.attached ? 'turn_off_port' : 'turn_on_port';
    await api.control(tool, { ports: [port.no] });
    await new Promise((r) => setTimeout(r, 1500));
    setStatus(await api.status());
  };

  const [settingsOpen, setSettingsOpen] = React.useState(() => window.location.hash === '#settings');
  // PD 协商快照（30s 轮询）：设备名/电池等，读不到就不显示
  const [pdMap, setPdMap] = React.useState({});
  React.useEffect(() => {
    const load = () => api.query('get_port_pd_status', {}).then((r) => {
      try {
        const all = JSON.parse(r?.result || 'null');
        const map = {};
        for (const p of all?.ports || []) map[p.port] = p;
        setPdMap(map);
      } catch {}
    }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  const reloadSettings = () => {
    api.settings().then(setSettings).catch(() => {});
    // 刷新速率保存后同步页面轮询节奏
    fetch('/api/config').then((r) => r.json()).then((c) => {
      if (c.metricsIntervalMs) setPollMs(Math.max(250, c.metricsIntervalMs));
    }).catch(() => {});
  };

  return (
    <>
      <Header status={status} mcp={mcp} onOpenSettings={() => setSettingsOpen(true)} />
      <Overview status={status} />
      <div className="ports">
        {status?.data?.ports.slice().sort((a, b) => (a.type === 'A') - (b.type === 'A')).map((p) => <PortCard key={p.idx} port={p} onToggle={togglePort} pdInfo={pdMap[p.no]} />)}
      </div>
      <StatsBar status={status} />
      <ChartSection />
      <ControlPanel />
      <AgentConsole settings={settings} />
      <SystemDrawer status={status} />
      <div className="footer">
        <img src="/brand/candysign.png" alt="CANDYSIGN" className="footer-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <div>ChargeAgent v{VERSION} · 数据来自本地 IonBridge + 官方云端 MCP · 用 <span className="heart">⚡</span> 和 FluxAI 自由流® 驱动</div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSaved={reloadSettings} />
    </>
  );
}


// ─────────────────────────────────────────────
// 菜单栏弹窗专用布局（#popover）：紧凑、单栏、只保留核心信息
// ─────────────────────────────────────────────

function PpLiveChart() {
  const [raw, setRaw] = React.useState([]);
  React.useEffect(() => {
    const load = () => api.live(600).then((r) => setRaw((r.ports || []).map((p) => p.points))).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  const names = ['A', 'C1', 'C2', 'C3', 'C4'];
  const series = raw
    .map((points, port) => ({ port, name: names[port], color: PORT_COLORS[port], points: points.map(([ts, w]) => [Math.floor(ts / 1000), w]) }))
    .filter((s) => s.points.length > 1);
  return <PowerChart series={series} height={110} />;
}

function PpAgent({ settings }) {
  const [sessionId, setSessionId] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const logRef = React.useRef(null);
  React.useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    try {
      const r = await api.chat({ sessionId, message: text, provider: settings?.provider });
      setSessionId(r.sessionId);
      setMessages((m) => [...m, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `出错了：${e.message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="pp-agent">
      <div className="pp-agent-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="pp-agent-hint">问我充电状态，或说「切到魔拟充」「关掉 C4」⚡</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`pp-msg ${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="pp-msg assistant">…</div>}
      </div>
      <div className="pp-agent-input">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="问点什么…" disabled={busy} />
        <button className="btn" onClick={send} disabled={busy || !input.trim()}>发送</button>
      </div>
    </div>
  );
}

function PopoverApp() {
  const [status, setStatus] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [pdMap, setPdMap] = React.useState({});

  React.useEffect(() => {
    const t = setInterval(() => api.status().then(setStatus).catch(() => {}), 500);
    api.status().then(setStatus).catch(() => {});
    api.settings().then(setSettings).catch(() => {});
    return () => clearInterval(t);
  }, []);

  // PD 协商快照（30s）：设备名/电池，读不到不显示
  React.useEffect(() => {
    const load = () => api.query('get_port_pd_status', {}).then((r) => {
      try {
        const all = JSON.parse(r?.result || 'null');
        const map = {};
        for (const p of all?.ports || []) map[p.port] = p;
        setPdMap(map);
      } catch {}
    }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const d = status?.data;
  const sorted = d?.ports.slice().sort((a, b) => (a.type === 'A') - (b.type === 'A')) || [];
  const pct = d ? Math.min(100, (d.totalW / d.budgetTotalW) * 100) : 0;

  const togglePort = async (port) => {
    const tool = port.attached ? 'turn_off_port' : 'turn_on_port';
    await api.control(tool, { ports: [port.no] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    setStatus(await api.status());
  };

  return (
    <div className="pp">
      {/* 顶栏：字标 + 状态 */}
      <div className="pp-head">
        <img src="/brand/xiaodianpin.png" alt="小电拼" className="wordmark" />
        <span className={`dot ${status?.online ? '' : 'off'}`}></span>
        <span className="pp-state">{status?.online ? '在线' : '离线'}</span>
      </div>

      {/* 总功率 + 整机条 */}
      <div className="pp-total">
        <div className="pp-num">{d ? d.totalW : '--'}<small> W</small></div>
        <div className="pp-total-right">
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${pct}%`, background: 'var(--ink)' }} />
          </div>
          <div className="pp-total-cap">整机 {d ? `${d.totalW} / ${d.budgetTotalW}W` : '--'} · 活跃 {d?.chargingPorts ?? '-'}/5 口</div>
        </div>
      </div>

      {/* 五口紧凑列表 */}
      <div className="pp-ports">
        {sorted.map((p) => (
          <div key={p.idx} className={`pp-port ${p.attached ? 'on' : ''} ${p.active ? '' : 'closed'}`}>
            <span className="pp-port-dot" style={{ background: PORT_COLORS[p.idx] }} />
            <div className="pp-port-mid">
              <div className="pp-port-line1">
                <b>{p.name}</b>
                {(() => {
                  const pd = pdMap[p.no];
                  if (!pd) return null;
                  return (
                    <>
                      {pd.device_name_zh && <span className="pp-port-dev">{pd.device_name_zh}</span>}
                      {fmtBatt(pd) && <span className="pp-port-batt">{fmtBatt(pd)}</span>}
                    </>
                  );
                })()}
              </div>
              <div className="pp-port-line2">{p.attached ? `${p.voltageV.toFixed(1)}V · ${p.currentA.toFixed(2)}A · ${p.protocol}` : p.active ? '空闲' : '已关闭'}</div>
            </div>
            <div className="pp-port-right">
              <div className="pp-port-w">{p.powerW}<small> W</small></div>
              {!p.active ? (
                <button className="pp-toggle" onClick={() => togglePort(p)} title="重新启用该口并恢复供电">开启</button>
              ) : (
                <button className={`pp-toggle ${p.attached ? 'danger' : ''}`} onClick={() => togglePort(p)}
                  title={p.attached ? '物理断电（等效拔线）' : '关闭该口输出'}>关闭</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 实时功率曲线 */}
      <div className="pp-section">
        <div className="pp-section-title">实时功率曲线</div>
        <PpLiveChart />
      </div>

      {/* Agent 快捷对话 */}
      <PpAgent settings={settings} />

      <div className="pp-version">ChargeAgent v{VERSION}</div>
    </div>
  );
}

export default function App() {
  const hash = window.location.hash;
  if (hash.includes('mini')) return <MiniApp />;
  if (hash.includes('popover')) return <PopoverApp />;
  return <FullApp />;
}

// ─────────────────────────────────────────────
// 桌面悬浮迷你窗（#mini）：置顶小卡片，500ms 实时
// ─────────────────────────────────────────────
function MiniApp() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    const t = setInterval(() => api.status().then(setStatus).catch(() => {}), 500);
    api.status().then(setStatus).catch(() => {});
    return () => clearInterval(t);
  }, []);

  const d = status?.data;
  const sorted = d?.ports.slice().sort((a, b) => (a.type === 'A') - (b.type === 'A')) || [];
  const pct = d ? Math.min(100, (d.totalW / d.budgetTotalW) * 100) : 0;
  // 环形仪表参数
  const R = 24, CIRC = 2 * Math.PI * R;

  return (
    <div className="mini">
      <div className="mini-card">
        <button className="mini-close" title="关闭悬浮窗" onClick={() => window.close()}>×</button>
        <div className="mini-head">
          <img src="/brand/xiaodianpin.png" alt="小电拼" className="wordmark" />
          <span className="mini-head-right">
            <span className={`dot ${status?.online ? '' : 'off'}`}></span>
            <span className="mini-head-label">{status?.online ? '在线' : '离线'}</span>
          </span>
        </div>
        <div className="mini-body">
          <div className="mini-left">
            <div className="mini-num">{d ? d.totalW : '--'}<small> W</small></div>
            <div className="mini-caption">整机实时输出</div>
            <div className="mini-sub">{d ? `活跃 ${d.chargingPorts}/5 口` : '—'}</div>
          </div>
          <svg className="mini-gauge" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r={R} fill="none" strokeWidth="7"
              style={{ stroke: 'var(--paper-deep)' }} />
            <circle
              cx="32" cy="32" r={R} fill="none" strokeWidth="7" strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * CIRC} ${CIRC}`}
              transform="rotate(-90 32 32)"
              style={{ stroke: 'var(--red)' }}
            />
            <text x="32" y="36" textAnchor="middle" className="mini-gauge-text">
              {Math.round(pct)}%
            </text>
          </svg>
        </div>
        <div className="mini-ports">
          {sorted.map((p) => (
            <div key={p.idx} className={`mini-port ${p.attached ? 'on' : ''} ${p.active ? '' : 'closed'}`} title={`${p.name}${p.attached ? ` ${p.powerW}W` : p.active ? ' 空闲' : ' 已关闭'}`}>
              <span className="mini-port-dot" style={{ background: PORT_COLORS[p.idx] }} />
              <span className="mini-port-name">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
