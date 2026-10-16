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
const { spawn } = require('node:child_process');

const BACKEND_PORT = process.env.BACKEND_PORT || 8932;
// 手动打包的 bundle 不被 Electron 识别为 isPackaged，改用 app.asar 是否存在来判断环境
const isDev = !fs.existsSync(path.join(process.resourcesPath, 'app.asar'));
// 统一页面地址：dev 走 Vite（热更新），prod 走内置后端
const BASE_URL = isDev
  ? (process.env.VITE_DEV_SERVER_URL || 'http://localhost:7100')
  : `http://127.0.0.1:${BACKEND_PORT}`;
const FULL_URL = BASE_URL + '/';       // 完整网页版（浏览器打开）
const POPOVER_URL = BASE_URL + '/#popover'; // 弹窗专用紧凑布局

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

// ── 在线升级（GitHub Releases，electron-updater）──
// 手动触发：不自动检查，用户从托盘菜单点「检查更新」
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }
let updateState = null;   // {status: 'downloading'|'ready', version}
let checkingUpdate = false;

function buildTrayMenu() {
  const items = [];
  if (updateState?.status === 'ready') {
    items.push({ label: `重启安装更新 v${updateState.version}`, click: () => { app.isQuitting = true; autoUpdater.quitAndInstall(); } });
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

function setupUpdater() {
  if (isDev || !autoUpdater) return;
  autoUpdater.autoDownload = true; // 仅手动检查后触发下载
  autoUpdater.on('update-available', (info) => {
    clearTimeout(checkTimer);
    updateState = { status: 'downloading', version: info.version };
    mlog('[UPDATE] 发现新版本:', info.version);
    rebuildTrayMenu();
    updateNotify('发现新版本 v' + info.version, '正在后台下载，完成后会提醒你');
  });
  autoUpdater.on('update-not-available', () => {
    clearTimeout(checkTimer);
    mlog('[UPDATE] 已是最新');
    updateNotify('已是最新版本', `当前 v${app.getVersion()}，无需更新`);
    checkingUpdate = false;
    rebuildTrayMenu();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { status: 'ready', version: info.version };
    mlog('[UPDATE] 下载完成:', info.version);
    rebuildTrayMenu();
    updateNotify('新版本 v' + info.version + ' 已就绪', '点击此通知立即重启升级，或稍后在托盘菜单操作',
      () => { app.isQuitting = true; autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (e) => {
    mlog('[UPDATE] 错误:', String(e.message || e).slice(0, 300));
    checkingUpdate = false;
    updateState = null;
    rebuildTrayMenu();
  });
}

function manualCheckUpdate() {
  if (!autoUpdater || checkingUpdate || updateState) return;
  checkingUpdate = true;
  rebuildTrayMenu();
  autoUpdater.checkForUpdates().catch((e) => {
    mlog('[UPDATE] 检查失败:', String(e.message || e).slice(0, 300));
    checkingUpdate = false;
    rebuildTrayMenu();
    updateNotify('检查更新失败', '请检查网络后重试');
  });
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

  setupUpdater();

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
