// ── Electron 菜单栏外壳：托盘功率读数 + 弹出看板 + 通知 ──
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// 文件日志（LaunchServices 启动时控制台不可见）
const MAIN_LOG = path.join(os.homedir(), 'Library/Application Support/charge-agent/main.log');
function mlog(...args) {
  try {
    fs.mkdirSync(path.dirname(MAIN_LOG), { recursive: true });
    fs.appendFileSync(MAIN_LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch {}
}
mlog('[MAIN] entry loaded');

// 开发模式：加载 Vite dev server；生产模式：加载应用内后端托管的静态文件
const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const tls = require('node:tls');
const { URL: UrlURL } = require('node:url');

const BACKEND_PORT = process.env.BACKEND_PORT || 8932;
// 手动打包的 bundle 不被 Electron 识别为 isPackaged，改用 app.asar 是否存在来判断环境
const isDev = !fs.existsSync(path.join(process.resourcesPath, 'app.asar'));
// 统一页面地址：dev 走 Vite（热更新），prod 走内置后端
const BASE_URL = isDev
  ? (process.env.VITE_DEV_SERVER_URL || 'http://localhost:7100')
  : `http://127.0.0.1:${BACKEND_PORT}`;
const FULL_URL = BASE_URL + '/';       // 完整网页版（浏览器打开）
const POPOVER_URL = BASE_URL + '/#popover'; // 弹窗专用紧凑布局

// 单实例锁：防止登录项+手动启动等产生双开（双开会抢后端端口、托盘行为混乱）
if (!app.requestSingleInstanceLock()) {
  mlog('[MAIN] 已有实例在运行，退出');
  app.quit();
} else {
  app.on('second-instance', () => { if (win) showWindow(); });
}

let tray = null;
let win = null;
let backendProc = null;

// ── 托盘显示：字标 + 定宽等宽数字合成图（0.0–160.0W 全量预渲染，双主题）──
// 文本标题在 macOS 上用比例字体渲染（实测 6 字符宽度差 11px），改用图片彻底定宽
const trayAssets = path.join(__dirname, '..', 'assets', 'tray');
const wordmarkDarkBar = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'brand', 'wordmark-darkbar.png'));
const wordmarkLightBar = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'brand', 'wordmark-lightbar.png'));

let lastTrayKey = null;
let lastTotalW = null, lastOnline = true; // 供主题切换时重绘（true 避免启动误报上线通知）

function trayImagePath(totalW, online) {
  const theme = nativeTheme.shouldUseDarkColors ? 'lightbar' : 'darkbar';
  if (!online || totalW == null) return path.join(trayAssets, theme, 'off.png');
  const idx = Math.max(0, Math.min(1600, Math.round(totalW * 10)));
  return path.join(trayAssets, theme, `${String(idx).padStart(4, '0')}.png`);
}

function updateTrayDisplay(totalW, online) {
  if (!tray) return;
  const key = trayImagePath(totalW, online);
  if (key !== lastTrayKey) {
    lastTrayKey = key;
    tray.setImage(nativeImage.createFromPath(key));
    tray.setTitle('');
  }
  tray.setToolTip(`小电拼 2993 · ${online && totalW != null ? `${(Math.round(totalW * 10) / 10).toFixed(1)}W` : '离线'}`);
}

function positionWindow() {
  if (!win || !tray) return;
  const b = tray.getBounds();
  const [w, h] = win.getSize();
  const x = Math.max(8, Math.round(b.x + b.width / 2 - w / 2));
  const y = Math.round(b.y + b.height + 2);
  win.setPosition(x, y);
}

let showGuard = false; // 防止弹窗瞬间的 blur 把窗口立刻收走

// ── 桌面悬浮迷你窗（钉在桌面角落的实时功率窗）──
let miniWin = null;
const MINI_POS = path.join(os.homedir(), 'Library/Application Support/charge-agent/mini-pos.json');
const MINI_ENABLED = path.join(os.homedir(), 'Library/Application Support/charge-agent/.mini-enabled');

function createMiniWindow() {
  miniWin = new BrowserWindow({
    width: 320,
    height: 206,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    icon: wordmarkDarkBar,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // 恢复上次位置
  try {
    const pos = JSON.parse(fs.readFileSync(MINI_POS, 'utf-8'));
    if (Array.isArray(pos) && pos.length === 2) miniWin.setPosition(pos[0], pos[1]);
  } catch {}
  miniWin.loadURL(`${BASE_URL}/#mini`);
  // 自适应内容高度，杜绝裁切/错位
  miniWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      miniWin?.webContents.executeJavaScript(
        `Math.ceil(document.querySelector('.mini-card')?.getBoundingClientRect().height || 0)`
      ).then((h) => {
        if (h > 0) miniWin.setContentSize(320, h + 12);
      }).catch(() => {});
    }, 300);
  });
  let saveTimer = null;
  miniWin.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(MINI_POS, JSON.stringify(miniWin.getPosition())); } catch {}
    }, 400);
  });
  miniWin.on('closed', () => { miniWin = null; });
}

function toggleMiniWindow() {
  if (miniWin) { miniWin.close(); return false; }
  createMiniWindow();
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 720,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    icon: wordmarkDarkBar,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(POPOVER_URL);
  win.on('blur', () => {
    if (showGuard) return;
    if (!win.webContents.isDevToolsOpened()) win.hide();
  });
}

function showWindow() {
  if (!win) createWindow();
  positionWindow(); // 弹窗固定出现在托盘图标下方
  showGuard = true;
  win.show();
  win.focus();
  setTimeout(() => { showGuard = false; }, 400);
}

function toggleWindow() {
  if (!win) return showWindow();
  if (win.isVisible()) win.hide();
  else showWindow();
}

// ── 通知（插拔/离线/上线，5 分钟内去重）──
const notified = new Map();
function notify(title, body, key) {
  const now = Date.now();
  if (key && notified.has(key) && now - notified.get(key) < 5 * 60_000) return;
  notified.set(key || title, now);
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// ── 轮询后端状态：更新托盘 + 触发通知 ──
async function pollStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/status`);
    const d = await res.json();
    if (!tray) return;
    updateTrayDisplay(d.data?.totalW, d.online);
    lastTotalW = d.data?.totalW;
    if (d.online !== lastOnline) {
      notify('小电拼 2993', d.online ? '设备已上线' : '设备离线了，检查一下 Wi-Fi', 'online-state');
      lastOnline = d.online;
    }
  } catch {
    updateTrayDisplay(null, false);
  }
}

let sinceTs = 0;
async function pollEvents() {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/events?since=${sinceTs}`);
    const d = await res.json();
    if (!d.events?.length) return;
    sinceTs = d.events[d.events.length - 1].ts;
    for (const e of d.events) {
      if (e.type === 'attached') notify('设备插入', `${e.payload.port} 口接入了新设备`, `att-${e.ts}`);
      if (e.type === 'detached') notify('设备拔出', `${e.payload.port} 口断开 · 本次充电 ${Math.round(e.payload.durationS / 60)} 分钟`, `det-${e.ts}`);
    }
  } catch {}
}

function startBackend() {
  // 打包模式：以 Node 模式启动 asar 内的后端服务
  if (isDev) return;
  try {
    const serverEntry = path.join(process.resourcesPath, 'app.asar', 'server', 'index.mjs');
    const userData = app.getPath('userData');
    const logPath = path.join(userData, 'backend.log');
    fs.mkdirSync(userData, { recursive: true });
    const out = fs.openSync(logPath, 'a');
    mlog("[MAIN] spawning backend:", serverEntry);
    backendProc = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        CHARGEAGENT_DATA_DIR: userData, // 数据写到 ~/Library/Application Support/charge-agent
      },
      stdio: ['ignore', out, out],
    });
    backendProc.on('error', (e) => console.log('[MAIN] spawn error:', e.message));
    backendProc.on('exit', (code) => console.log('[MAIN] backend exited:', code));
  } catch (e) {
    mlog("[MAIN] startBackend failed:", e.message);
  }
}

// ── 在线升级（GitHub Releases，自实现：代理感知 + 本地替换安装）──
// electron-updater 在本环境静默失效（resolve null），且应用进程被按应用 VPN 拦截
// 直接访问 GitHub；改为：经本地代理(127.0.0.1:1082) CONNECT 隧道访问官方 API 与下载源
let updateState = null;   // {status: 'downloading'|'ready', version}
let checkingUpdate = false;
const UPDATE_PROXY = process.env.CHARGEAGENT_UPDATE_PROXY || 'http://127.0.0.1:1082';

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return false;
}

// 代理 CONNECT 隧道 + TLS 的一次 HTTPS 请求（返回 {status, headers, body(Buffer)}）
function httpsTunnelRequest(host, reqPath, { method = 'GET', timeout = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const px = new URL(UPDATE_PROXY);
    const socket = net.connect(Number(px.port || 1082), px.hostname, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error('代理连接超时')); });
    let handshake = Buffer.alloc(0);
    let tlsSock = null;
    const chunks = [];
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };

    socket.on('data', (d) => {
      if (!tlsSock) {
        handshake = Buffer.concat([handshake, d]);
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = handshake.slice(0, idx).toString('latin1');
        if (!/HTTP\/1\.[01] 200/.test(head)) return fail(new Error('代理 CONNECT 被拒: ' + head.split('\r\n')[0]));
        const rest = handshake.slice(idx + 4);
        tlsSock = tls.connect({ socket, servername: host }, () => {
          const hdrs = Object.entries({ Host: host, 'User-Agent': 'ChargeAgent', Connection: 'close', ...headers })
            .map(([k, v]) => `${k}: ${v}`).join('\r\n');
          tlsSock.write(`${method} ${reqPath} HTTP/1.1\r\n${hdrs}\r\n\r\n`);
        });
        tlsSock.on('data', (td) => chunks.push(td));
        tlsSock.on('end', () => {
          if (done) return;
          done = true;
          const raw = Buffer.concat(chunks);
          const hEnd = raw.indexOf('\r\n\r\n');
          const headText = raw.slice(0, hEnd).toString('latin1');
          const status = Number((headText.match(/HTTP\/1\.[01] (\d+)/) || [])[1] || 0);
          const headers = {};
          headText.split('\r\n').slice(1).forEach((line) => {
            const c = line.indexOf(':');
            if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          });
          resolve({ status, headers, body: raw.slice(hEnd + 4) });
        });
        tlsSock.on('error', fail);
        if (rest.length) socket.unshift ? null : null;
      }
    });
    socket.on('error', fail);
  });
}

// 跟随重定向的 GitHub API GET（body 限 32MB）
async function githubGet(url, depth = 0) {
  if (depth > 5) throw new Error('重定向过多');
  const u = new UrlURL(url);
  const r = await httpsTunnelRequest(u.hostname, u.pathname + u.search);
  if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
    return githubGet(new UrlURL(r.headers.location, url).toString(), depth + 1);
  }
  if (r.status !== 200) throw new Error(`GitHub HTTP ${r.status}`);
  return r.body.toString('utf-8');
}

function buildTrayMenu() {
  const items = [];
  if (updateState?.status === 'ready') {
    items.push({ label: `重启安装更新 v${updateState.version}`, click: () => installUpdate() });
  } else if (updateState?.status === 'downloading') {
    items.push({ label: `新版本 v${updateState.version} 下载中…`, enabled: false });
  } else if (checkingUpdate) {
    items.push({ label: '正在检查更新…', enabled: false });
  } else {
    items.push({ label: '检查更新', click: () => manualCheckUpdate() });
  }
  items.push({ type: 'separator' });
  items.push(
    { label: '桌面悬浮窗', type: 'checkbox', checked: fs.existsSync(MINI_ENABLED),
      click: (item) => {
        const on = toggleMiniWindow();
        item.checked = on;
        try { on ? fs.writeFileSync(MINI_ENABLED, '1') : fs.unlinkSync(MINI_ENABLED); } catch {}
      } },
    { label: '在浏览器中打开完整页面', click: () => shell.openExternal(FULL_URL) },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: autoStartEnabled(),
      click: (item) => setAutoStart(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}
// 菜单在每次右键时按需构建，无需预挂（setContextMenu 会让左键也弹菜单）
function rebuildTrayMenu() {}

function updateNotify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

// 手动检查：走 releases.atom（不受 API 速率限制），取最高版本号
async function manualCheckUpdate() {
  if (checkingUpdate || updateState) return;
  checkingUpdate = true;
  rebuildTrayMenu();
  mlog('[UPDATE] 手动检查开始, 当前 v' + app.getVersion(), '代理:', UPDATE_PROXY);
  try {
    // 用 /releases/latest 的 302 Location 拿「最新标记」的版本：比 atom 实时、比 API 抗限流
    const lr = await httpsTunnelRequest('github.com', '/Northwoodmy/charge-agent/releases/latest');
    if (![301, 302, 303, 307, 308].includes(lr.status) || !lr.headers.location) {
      throw new Error('查询最新版本 HTTP ' + lr.status);
    }
    const m = lr.headers.location.match(/tag\/v?([0-9]+\.[0-9]+\.[0-9]+)/);
    if (!m) throw new Error('无法从 Location 解析版本: ' + lr.headers.location);
    const remote = m[1];
    mlog('[UPDATE] 远端最新: v' + remote);
    if (!semverGt(remote, app.getVersion())) {
      checkingUpdate = false;
      rebuildTrayMenu();
      updateNotify('已是最新版本', `当前 v${app.getVersion()}，无需更新`);
      return;
    }
    const assetUrl = `https://github.com/Northwoodmy/charge-agent/releases/download/v${remote}/ChargeAgent-${remote}-arm64-mac.zip`;
    updateState = { status: 'downloading', version: remote, url: assetUrl, size: 0 };
    rebuildTrayMenu();
    updateNotify('发现新版本 v' + remote, '正在后台下载，完成后会提醒你');
    downloadUpdate(remote, assetUrl, 140 * 1048576);
  } catch (e) {
    mlog('[UPDATE] 检查失败:', String(e.message || e).slice(0, 300));
    checkingUpdate = false;
    rebuildTrayMenu();
    updateNotify('检查更新失败', String(e.message || '未知错误').slice(0, 140));
  }
}

// 经代理隧道下载 zip（解析响应头、跟随重定向、支持断点续传——代理长连接常被掐断）
let downloadAttempt = 0; // 每次尝试唯一 ID：重定向/过期套接字的事件一律作废
function downloadUpdate(version, url, total, depth = 0, offset = 0) {
  const myId = ++downloadAttempt;
  const active = () => myId === downloadAttempt;
  if (depth > 8) return onDownloadError(new Error('重定向/续传次数过多'), active);
  const outPath = path.join(os.homedir(), 'Library/Application Support/charge-agent/update-' + version + '.zip');
  const u = new UrlURL(url);
  mlog('[UPDATE] 下载:', u.hostname, depth ? `(第${Math.ceil(depth / 2)}次接续)` : '', '已收', Math.round(offset / 1048576) + 'MB');
  const px = new URL(UPDATE_PROXY);
  const socket = net.connect(Number(px.port || 1082), px.hostname, () => {
    socket.write(`CONNECT ${u.hostname}:443 HTTP/1.1\r\nHost: ${u.hostname}:443\r\n\r\n`);
  });
  socket.setTimeout(30_000, () => { socket.destroy(); onDownloadError(new Error('下载连接超时'), active); });
  let handshake = Buffer.alloc(0), tlsSock = null, fileOut = null, got = 0, lastLog = 0;
  let resHead = Buffer.alloc(0), headParsed = false;

  const onDownloadError = (e, act) => {
    if (act && !act()) return; // 已被更新的尝试取代
    mlog('[UPDATE] 下载失败:', String(e.message || e).slice(0, 200));
    try { fileOut?.close(); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
    updateState = null;
    checkingUpdate = false;
    rebuildTrayMenu();
    updateNotify('更新下载失败', String(e.message || '网络错误').slice(0, 120));
  };

  socket.on('data', (d) => {
    if (!tlsSock) {
      handshake = Buffer.concat([handshake, d]);
      const idx = handshake.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = handshake.slice(0, idx).toString('latin1');
      if (!/HTTP\/1\.[01] 200/.test(head)) return onDownloadError(new Error('代理 CONNECT 被拒'));
      tlsSock = tls.connect({ socket, servername: u.hostname }, () => {
        const rangeHdr = offset > 0 ? `Range: bytes=${offset}-\r\n` : '';
        tlsSock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: ChargeAgent\r\nAccept: application/octet-stream\r\n${rangeHdr}Connection: close\r\n\r\n`);
      });
      // 分块解码状态：CDN 返回 Transfer-Encoding: chunked，必须剥掉分块框架
      let chunked = false, chunkSize = -1, chunkBuf = Buffer.alloc(0), streamDone = false;
      const writeBody = (buf) => { got += buf.length; fileOut.write(buf); };
      const finishStream = () => {
        if (streamDone || !active()) return;
        streamDone = true;
        const received = offset + got;
        // 代理掐断：按 Range 断点续传
        if (expected > 0 && got < expected && received < total) {
          mlog('[UPDATE] 连接中断:', Math.round(got / 1048576) + '/', Math.round(expected / 1048576) + 'MB，断点续传');
          try { tlsSock.removeAllListeners(); socket.removeAllListeners(); socket.destroy(); } catch {}
          downloadAttempt++; // 作废本尝试
          return downloadUpdate(version, url, total, depth + 1, received);
        }
        fileOut.end(() => {
          checkingUpdate = false;
          mlog('[UPDATE] 下载完成:', Math.round(received / 1048576) + 'MB');
          updateState = { status: 'ready', version, path: outPath };
          rebuildTrayMenu();
          updateNotify('新版本 v' + version + ' 已就绪', '点击此通知立即重启升级，或稍后在托盘菜单操作', () => installUpdate());
        });
      };
      const feedChunked = (buf) => {
        chunkBuf = Buffer.concat([chunkBuf, buf]);
        for (;;) {
          if (chunkSize < 0) {
            const li = chunkBuf.indexOf('\r\n');
            if (li < 0) return;
            const sizeLine = chunkBuf.slice(0, li).toString('latin1').split(';')[0].trim();
            chunkSize = parseInt(sizeLine, 16);
            chunkBuf = chunkBuf.slice(li + 2);
            if (chunkSize === 0) { finishStream(); return; }
          } else {
            if (chunkBuf.length < chunkSize + 2) return;
            writeBody(chunkBuf.slice(0, chunkSize));
            chunkBuf = chunkBuf.slice(chunkSize + 2); // 数据 + 尾部 CRLF
            chunkSize = -1;
          }
        }
      };
      tlsSock.on('data', (td) => {
        if (!headParsed) {
          resHead = Buffer.concat([resHead, td]);
          const he = resHead.indexOf('\r\n\r\n');
          if (he < 0) return;
          const text = resHead.slice(0, he).toString('latin1');
          const status = Number((text.match(/HTTP\/1\.[01] (\d+)/) || [])[1] || 0);
          if ([301, 302, 303, 307, 308].includes(status)) {
            const loc = /location:\s*(\S+)/i.exec(text)?.[1];
            if (!loc) return onDownloadError(new Error('重定向缺 Location'), active);
            downloadAttempt++;
            try { tlsSock.removeAllListeners(); socket.removeAllListeners(); socket.destroy(); } catch {}
            return downloadUpdate(version, new UrlURL(loc, url).toString(), total, depth + 1);
          }
          if (status !== 200) return onDownloadError(new Error('下载 HTTP ' + status), active);
          headParsed = true;
          chunked = /chunked/i.test(text);
          expected = Number(/content-length:\s*(\d+)/i.exec(text)?.[1] || 0);
          fileOut = fs.createWriteStream(outPath, offset > 0 ? { flags: 'a' } : {});
          const rest = resHead.slice(he + 4);
          if (rest.length) chunked ? feedChunked(rest) : writeBody(rest);
          if (!chunked) got = rest.length;
          return;
        }
        if (chunked) feedChunked(td);
        else { writeBody(td); if (got - lastLog > 20 * 1048576) { lastLog = got; mlog('[UPDATE] 下载进度:', Math.round(got / 1048576) + 'MB'); } }
      });
      tlsSock.on('end', () => {
        if (!active()) return;
        if (!headParsed) return onDownloadError(new Error('响应异常（连接被提前关闭）'), active);
        if (chunked && !streamDone) return onDownloadError(new Error('下载不完整（分块流提前结束）'), active);
        finishStream();
      });
      tlsSock.on('error', (e) => onDownloadError(e, active));
    }
  });
  socket.on('error', (e) => onDownloadError(e, active));
}

// 安装前先校验安装包完整性；通过后后台脚本解包替换重启（避免自删自己）
function installUpdate() {
  if (updateState?.status !== 'ready' || !updateState.path) return;
  const zip = updateState.path;
  if (!fs.existsSync(zip)) { updateNotify('安装失败', '安装包不存在，请重新检查更新'); return; }
  mlog('[UPDATE] 校验安装包:', zip);
  const chk = spawnSync('unzip', ['-t', zip], { encoding: 'utf-8' });
  if (chk.status !== 0 || !/No errors/i.test(chk.stdout || '')) {
    mlog('[UPDATE] 安装包损坏:', (chk.stdout || chk.stderr || '').slice(-200));
    try { fs.unlinkSync(zip); } catch {}
    updateState = null;
    rebuildTrayMenu();
    updateNotify('安装包已损坏', '已清理，请重新「检查更新」下载');
    return;
  }
  mlog('[UPDATE] 校验通过，开始安装');
  const script = `#!/bin/bash
exec >/tmp/chargeagent-install.log 2>&1
set -e
sleep 1
rm -rf /tmp/chargeagent-update
unzip -oq "${zip}" -d /tmp/chargeagent-update
rm -rf "/Applications/ChargeAgent.app"
mv "/tmp/chargeagent-update/ChargeAgent.app" /Applications/ChargeAgent.app
xattr -dr com.apple.quarantine "/Applications/ChargeAgent.app" 2>/dev/null
rm -f "${zip}"
sleep 1
open /Applications/ChargeAgent.app
`;
  const sp = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  sp.unref();
  app.isQuitting = true;
  app.quit();
}

// ── 开机自启（登录项，签名应用可用）──
const AUTOSTART_MARKER = path.join(os.homedir(), 'Library/Application Support/charge-agent/.autostart-default-on');
function autoStartEnabled() { return app.getLoginItemSettings().openAtLogin; }
function setAutoStart(enable) { app.setLoginItemSettings({ openAtLogin: enable }); }
// 首次运行默认开启开机自启（菜单栏应用的常规期望）
function enableAutoStartFirstRun() {
  try {
    if (!fs.existsSync(AUTOSTART_MARKER)) {
      fs.mkdirSync(path.dirname(AUTOSTART_MARKER), { recursive: true });
      app.setLoginItemSettings({ openAtLogin: true });
      fs.writeFileSync(AUTOSTART_MARKER, '1');
      mlog('[MAIN] first run: autostart enabled');
    }
  } catch {}
}

app.whenReady().then(() => {
  mlog("[MAIN] ready isDev:", isDev);
  if (!isDev && app.dock) app.dock.hide(); // 打包版隐藏 Dock 图标（纯菜单栏应用）
  enableAutoStartFirstRun();
  // 上次开启过悬浮窗则自动恢复：等后端就绪再建窗（否则页面加载失败、透明窗隐形）
  if (fs.existsSync(MINI_ENABLED)) {
    const tryCreate = (left) => {
      fetch(`http://127.0.0.1:${BACKEND_PORT}/api/config`)
        .then(() => createMiniWindow())
        .catch(() => { if (left > 0) setTimeout(() => tryCreate(left - 1), 800); });
    };
    tryCreate(25);
  }

  startBackend();

  tray = new Tray(nativeImage.createFromPath(trayImagePath(null, false)));
  tray.setToolTip('小电拼 2993 · 充电管家');
  // 系统主题切换时换字标配色
  nativeTheme.on('updated', () => { lastTrayKey = null; updateTrayDisplay(lastTotalW, lastOnline); });
  // 右键菜单（macOS 上 setContextMenu 会让左键也弹菜单，所以改用手动 popUp）
  tray.on('click', toggleWindow);                      // 左键：直接弹/收看板
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu())); // 右键：菜单（按需构建，标签永远新鲜）


  setInterval(pollStatus, 500);
  setInterval(pollEvents, 5000);
  pollStatus();

  // 调试/演示：CHARGEAGENT_SHOW_WINDOW=1 时启动即弹出看板窗口
  if (process.env.CHARGEAGENT_SHOW_WINDOW) {
    createWindow();
    win.show();
  }

  app.on('activate', toggleWindow);
});

app.on('before-quit', () => backendProc?.kill());
app.on('window-all-closed', (e) => { if (!app.isQuitting) e.preventDefault(); });
