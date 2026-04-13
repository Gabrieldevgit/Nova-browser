// ── Pre-app setup ─────────────────────────────────────────────────────────────
// Must be before app import calls
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

const { app, BrowserWindow, ipcMain, session, BrowserView, Menu, shell, dialog, net } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { pathToFileURL } = require('url');

// Prevent multiple Electron instances from conflicting on same userData
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Nova] Another instance is running — quitting this one.');
  app.quit();
}
app.on('second-instance', (e, argv) => {
  // If someone launches a second Nova, focus the existing window
  windowContexts.forEach(ctx => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
      ctx.mainWindow.focus();
    }
  });
});

// Fix Google sign-in: spoof Chrome command-line flags
// NOTE: CrossOriginOpenerPolicy must NOT be disabled — YouTube needs it
// We strip COOP headers at the network layer instead (see webRequest below)
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('no-sandbox');

// ── Fix cache/GPU errors (Images 1 & 2 in bug report) ────────────────────────
// Prevents: "Unable to move the cache: Access is denied"
// Prevents: "Gpu Cache Creation failed"
// Prevents: "Failed to reset the quota database"
// disk-cache-size=1 removed — causes 'Invalid cache size' error
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache'); // no GPU shader cache
// REMOVED: disable-background-networking  ← breaks YouTube media manifest fetching
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-default-apps');
// Prevent multiple instances locking the same profile
app.commandLine.appendSwitch('disable-session-crashed-bubble');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
// ── YouTube / media playback fixes ───────────────────────────────────────────
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features',
  'NetworkServiceInProcess2,' +
  'WebRtcHideLocalIpsWithMdns,' +
  'WebAuthnCableExtension,' +       // Passkey/FIDO2 cable transport
  'WebAuthenticationPasskeysInProfile,' +  // Passkey sync
  'AutofillEnablePasswordManagerPasskeys'  // Password manager passkeys
);
// Hardware video acceleration — critical for YouTube 1080p+
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen,single-on-top,underlay');

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR  = app.getPath('userData');
const HIST_FILE = path.join(DATA_DIR, 'history.json');
const BM_FILE   = path.join(DATA_DIR, 'bookmarks.json');
const EXT_FILE  = path.join(DATA_DIR, 'extensions.json');
const EXT_DIR   = path.join(DATA_DIR, 'extensions');
const DL_DIR    = app.getPath('downloads');
[EXT_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

const readJ  = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} };

let history      = readJ(HIST_FILE, []);
let bookmarks    = readJ(BM_FILE,   []);
let savedExts    = readJ(EXT_FILE,  []);
let loadedExts   = [];
const dlMap      = new Map();
let dlId         = 0;
let blockedCount = 0;

// ── Tracker blocking ──────────────────────────────────────────────────────────
const TRACKERS = [
  'doubleclick.net','googleadservices.com','googlesyndication.com',
  'google-analytics.com','googletagmanager.com','googletagservices.com',
  'adnxs.com','adsrvr.org','rubiconproject.com','pubmatic.com',
  'openx.net','criteo.com','scorecardresearch.com','comscore.com',
  'quantserve.com','taboola.com','outbrain.com','hotjar.com',
  'mouseflow.com','fullstory.com','mixpanel.com','segment.io',
  'amplitude.com','facebook.net','connect.facebook.net',
  'ads.twitter.com','analytics.tiktok.com','px.ads.linkedin.com',
  'adform.net','moatads.com','statcounter.com',
];
const isBlocked = url => {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return TRACKERS.some(t => h === t || h.endsWith('.' + t));
  } catch { return false; }
};

// ── Chrome UA (no Electron) ───────────────────────────────────────────────────
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Script injected into every page to remove Electron fingerprints
const UA_SPOOF_SCRIPT = `
(function(){
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    if (navigator.userAgentData) {
      const brands = [
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Chromium',    version: '136' },
        { brand: 'Google Chrome', version: '136' },
      ];
      const uad = {
        brands, mobile: false, platform: 'Windows',
        getHighEntropyValues: async (hints) => ({
          brands,
          mobile: false,
          platform: 'Windows',
          architecture: 'x86', bitness: '64',
          platformVersion: '10.0.0',
          uaFullVersion: '136.0.0.0',
          fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })),
        }),
      };
      Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true });
    }
    // window.chrome — YouTube and Google services require specific properties
    const _chromeMock = {
      runtime: { id: undefined, connect: ()=>{}, sendMessage: ()=>{} },
      loadTimes: () => ({ requestTime: Date.now()/1000, startLoadTime: Date.now()/1000,
        commitLoadTime: Date.now()/1000, finishDocumentLoadTime: 0, finishLoadTime: 0,
        firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other',
        wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }),
      csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 }),
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
    };
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { get: () => _chromeMock, configurable: true });
    } else {
      // Patch missing properties on existing chrome object
      try { if(!window.chrome.loadTimes) window.chrome.loadTimes = _chromeMock.loadTimes; } catch(e) {}
      try { if(!window.chrome.csi) window.chrome.csi = _chromeMock.csi; } catch(e) {}
    }
  } catch(_) {}
})();
`;

// ── Window contexts ───────────────────────────────────────────────────────────
const windowContexts = new Map();
let ctxIdCounter = 0;
const getCtx = sender => windowContexts.get(sender.id);

function broadcast(channel, data) {
  windowContexts.forEach(ctx => {
    if (!ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send(channel, data);
  });
}

// ── Safe URL helper (handles about:, chrome:, view-source:, nova:) ─────────────
function isSafeURL(url) {
  if (!url) return false;
  const safe = /^(https?|ftp|file|about|data|blob|view-source):/i;
  return safe.test(url) || url === 'about:blank' || url === 'about:newtab';
}

// ── Create Window ─────────────────────────────────────────────────────────────
function createWindow(isPrivate = false, initialUrl = null, pos = null) {
  const ctxId   = ++ctxIdCounter;
  const privSes = isPrivate
    ? session.fromPartition(`private:${ctxId}`, { cache: false })
    : session.defaultSession;

  const winOpts = {
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    show: false, frame: false,
    backgroundColor: isPrivate ? '#0e0b1a' : '#13131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true,  webSecurity: false, sandbox: false,
      session: privSes,
    },
  };
  if (pos) { winOpts.x = pos.x; winOpts.y = pos.y; }

  const win = new BrowserWindow(winOpts);

  // Strip Electron from outgoing UA for the UI window
  win.webContents.setUserAgent(CHROME_UA);

  const wcId = win.webContents.id; // cache before window can be destroyed (Bug #3 fix)
  const ctx = {
    id: ctxId, mainWindow: win, isPrivate, session: privSes,
    views: new Map(), activeViewId: null, viewExtraTop: 0, panelExtraTop: 0, sidebarWidth: 0,
    chromeHeight: 88, // dynamically updated by renderer via 'set-chrome-height'
    splitActive: false, splitSecondaryId: null, splitRatio: 0.5,
    detachedTabUrl: initialUrl,
  };
  windowContexts.set(wcId, ctx);

  win.once('ready-to-show', () => { win.show(); win.focus(); });
  setTimeout(() => { if (!win.isVisible()) { win.show(); win.focus(); } }, 2000);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('init', {
      date: new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }),
      bookmarks, history: history.slice(0, 100), blocked: blockedCount,
      isPrivate, extensions: loadedExts,
      initialUrl,
    });
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log(`[UI:${ctxId}]`, m));
  win.on('resize',     () => repositionView(ctx));
  win.on('enter-full-screen', () => {
    // BrowserView fills entire window in fullscreen
    if (!ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('fullscreen-change', { active: true });
    repositionView(ctx);
  });
  win.on('leave-full-screen', () => {
    if (!ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('fullscreen-change', { active: false });
    repositionView(ctx);
  });
  win.on('maximize',   () => win.webContents.send('win-state', { maximized: true  }));
  win.on('unmaximize', () => win.webContents.send('win-state', { maximized: false }));
  win.on('closed',     () => { windowContexts.delete(wcId); });

  // Strip Electron headers from all outgoing requests in this session
  privSes.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
    const h = { ...details.requestHeaders };
    if (h['User-Agent']) h['User-Agent'] = h['User-Agent'].replace(/\s*Electron\/[\d.]+/g, '');
    cb({ requestHeaders: h });
  });
  if (isPrivate) {
    privSes.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      if (details.url.toLowerCase().includes('nova-d.access')) return cb({ cancel: true });
      if (isBlocked(details.url)) { blockedCount++; broadcast('blocked-count', blockedCount); return cb({ cancel: true }); }
      cb({});
    });
    privSes.webRequest.onHeadersReceived((details, cb) => {
      const h = { ...details.responseHeaders };
      delete h['x-frame-options']; delete h['X-Frame-Options'];
      cb({ responseHeaders: h });
    });
  }

  // Strip headers that break embeds and YouTube player from ALL sessions
  const _stripHeaders = (details, cb) => {
    const h = { ...details.responseHeaders };
    // These block iframes and cross-origin media loading
    delete h['x-frame-options'];
    delete h['X-Frame-Options'];
    // Strip COOP/COEP that break YouTube's SharedArrayBuffer video pipeline
    delete h['cross-origin-opener-policy'];
    delete h['Cross-Origin-Opener-Policy'];
    delete h['cross-origin-embedder-policy'];
    delete h['Cross-Origin-Embedder-Policy'];
    cb({ responseHeaders: h });
  };
  session.defaultSession.webRequest.onHeadersReceived(_stripHeaders);

  const htmlURL = pathToFileURL(path.join(__dirname, 'src', 'index.html')).href;
  win.loadURL(htmlURL).catch(err => console.error('[Nova] Load error:', err));
  return ctx;
}

// ── View layout ───────────────────────────────────────────────────────────────
function getContentBounds(ctx, side='full') {
  const [w, h] = ctx.mainWindow.getContentSize();
  // In fullscreen: BrowserView fills entire window (0,0 to w,h)
  if (ctx.mainWindow.isFullScreen()) {
    if (side === 'left')  { const lw = Math.floor(w * (ctx.splitRatio||0.5)); return { x:0, y:0, width:lw, height:h }; }
    if (side === 'right') { const lw = Math.floor(w * (ctx.splitRatio||0.5)); return { x:lw+4, y:0, width:w-lw-4, height:h }; }
    return { x: 0, y: 0, width: w, height: h };
  }
  // Normal mode: CRITICAL clamp so BrowserView NEVER overlaps navbar/toolbar
  const rawTop = (ctx.chromeHeight || 88) + (ctx.viewExtraTop||0) + (ctx.panelExtraTop||0);
  const TOP = Math.max(60, rawTop);       // exact chrome height, no extra padding
  const BOT = 22; // status bar height
  const H = Math.max(0, h - TOP - BOT);
  if (ctx.splitActive) {
    const ratio = ctx.splitRatio || 0.5;
    const divW = 4;
    const leftW = Math.floor((w - divW) * ratio);
    const rightW = w - divW - leftW;
    if (side === 'left')  return { x: 0,           y: TOP, width: leftW,  height: H };
    if (side === 'right') return { x: leftW + divW, y: TOP, width: rightW, height: H };
  }
  const SW = ctx.sidebarWidth || 0;  // sidebar takes right edge
  return { x: 0, y: TOP, width: Math.max(200, w - SW - (ctx.verticalTabWidth||0)), height: H };
}
function repositionView(ctx) {
  // Never move BrowserView back into view while an overlay/dialog is showing
  if (ctx._overlayOpen) return;
  if (!ctx.activeViewId) return;
  const v = ctx.views.get(ctx.activeViewId);
  if (v) v.setBounds(getContentBounds(ctx, ctx.splitActive ? 'left' : 'full'));
  if (ctx.splitActive && ctx.splitSecondaryId) {
    const sv = ctx.views.get(ctx.splitSecondaryId);
    if (sv) sv.setBounds(getContentBounds(ctx, 'right'));
  }
}
function sendNavState(ctx, tabId, view) {
  if (ctx.mainWindow.isDestroyed()) return;
  ctx.mainWindow.webContents.send('nav-state', {
    tabId,
    canGoBack:    view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
    isLoading:    view.webContents.isLoading(),
    url:          view.webContents.getURL(),
    zoom:         Math.round(view.webContents.getZoomFactor() * 100),
    isMuted:      view.webContents.isAudioMuted(),
  });
}

// ── Create BrowserView ────────────────────────────────────────────────────────
function createView(ctx, tabId, url) {
  const ses = ctx.isPrivate ? ctx.session : session.defaultSession;
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-page.js'),  // intercepts alert/confirm/prompt
      contextIsolation: false,  // needed so preload can access page window object
      nodeIntegration: false,
      webSecurity: false, sandbox: false, session: ses
    },
  });
  view.webContents.setUserAgent(CHROME_UA);
  // YouTube checks session-level UA too
  try { ses.setUserAgent(CHROME_UA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'); } catch(e) {}
  view.setBounds(getContentBounds(ctx));
  view.setAutoResize({ width: true, height: true });

  const send = (ch, d) => { if (!ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send(ch, d); };

  // Inject UA spoof into every page (fixes Google sign-in)
  view.webContents.on('dom-ready', async () => {
    // 1. Spoof UA fingerprint
    try { await view.webContents.executeJavaScript(UA_SPOOF_SCRIPT); } catch(err) {}

    // Dialog interception is handled by preload-page.js (proper IPC approach)
  });

  view.webContents.on('did-navigate', (e, u) => {
    const title = view.webContents.getTitle();
    send('tab-navigated', { tabId, url: u, title });
    sendNavState(ctx, tabId, view);
    if (!ctx.isPrivate && u && !u.startsWith('about:') && !u.startsWith('chrome:') && !u.startsWith('devtools:'))
      pushHistory(u, title, null);
  });
  view.webContents.on('did-navigate-in-page', (e, u) => {
    send('tab-navigated', { tabId, url: u, title: view.webContents.getTitle() });
    sendNavState(ctx, tabId, view);
  });
  view.webContents.on('page-title-updated', (e, t) => {
    send('tab-title-updated', { tabId, title: t });
    if (!ctx.isPrivate) { const h = history.find(x => x.url === view.webContents.getURL()); if (h) { h.title = t; writeJ(HIST_FILE, history); } }
  });
  view.webContents.on('page-favicon-updated', (e, favs) => {
    if (!favs[0]) return;
    send('tab-favicon-updated', { tabId, favicon: favs[0] });
    if (!ctx.isPrivate) { const h = history.find(x => x.url === view.webContents.getURL()); if (h) { h.favicon = favs[0]; writeJ(HIST_FILE, history); } }
  });
  view.webContents.on('did-start-loading',   ()    => send('tab-loading', { tabId, loading: true  }));
  view.webContents.on('did-stop-loading',    ()    => { send('tab-loading', { tabId, loading: false }); sendNavState(ctx, tabId, view); });
  view.webContents.on('did-fail-load', (e, code, desc, failUrl) => {
    // -3 = ERR_ABORTED (user nav/redirect), 0 = no error — ignore both
    if (code === -3 || code === 0) return;
    // Don't inject on internal protocols
    if (!failUrl || !/^https?:\/\//i.test(failUrl)) return;
    const errorPage = generateErrorPage(code, desc, failUrl);
    view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage)).catch(() => {});
    send('tab-navigated', { tabId, url: failUrl, title: 'Page unavailable' });
    send('tab-loading', { tabId, loading: false });
  });
  view.webContents.on('found-in-page', (e, r) => {
    send('find-result', { tabId, active: r.activeMatchOrdinal, total: r.matches });
  });
  view.webContents.on('audio-state-changed', () => {
    send('tab-audio', { tabId, audible: view.webContents.isCurrentlyAudible(), muted: view.webContents.isAudioMuted() });
  });

  // Context menu
  view.webContents.on('context-menu', (e, p) => {
    const { clipboard } = require('electron');
    const items = [];
    if (p.canGoBack)    items.push({ label: 'Back',    click: () => view.webContents.goBack()    });
    if (p.canGoForward) items.push({ label: 'Forward', click: () => view.webContents.goForward() });
    items.push({ label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => view.webContents.reload() });
    if (p.canGoBack || p.canGoForward) items.push({ type: 'separator' });
    if (p.linkURL) {
      items.push({ label: 'Open Link in New Tab',     click: () => send('open-url-new-tab', { url: p.linkURL }) });
      items.push({ label: 'Open Link in Private Tab', click: () => send('open-url-private-tab', { url: p.linkURL }) });
      items.push({ label: 'Copy Link Address',        click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.selectionText) {
      items.push({ label: `Search for "${p.selectionText.slice(0,30)}"`,
        click: () => send('open-url-new-tab', { url: `https://www.google.com/search?q=${encodeURIComponent(p.selectionText)}` }) });
      items.push({ label: 'Copy', role: 'copy' });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' });
      items.push({ type: 'separator' });
    }
    if (p.srcURL && p.mediaType === 'image') {
      items.push({ label: 'Open Image in New Tab', click: () => send('open-url-new-tab', { url: p.srcURL }) });
      items.push({ label: 'Copy Image URL',        click: () => clipboard.writeText(p.srcURL) });
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Save As…',      click: () => view.webContents.downloadURL(view.webContents.getURL()) });
    items.push({ label: 'Print…',        click: () => view.webContents.print() });
    items.push({ label: 'Screenshot',    click: () => takeScreenshot(ctx, tabId) });
    items.push({ label: 'Reader Mode',   click: () => send('keyboard-shortcut', { action: 'reader-mode', tabId }) });
    items.push({ type: 'separator' });
    items.push({ label: 'View Page Source', click: () => send('open-url-new-tab', { url: 'view-source:' + view.webContents.getURL() }) });
    items.push({ label: 'Inspect Element',  click: () => view.webContents.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: ctx.mainWindow });
  });

  // Keyboard shortcuts from BrowserView
  view.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key  = input.key;
    const ks   = (action, extra={}) => { e.preventDefault(); send('keyboard-shortcut', { action, tabId, ...extra }); };

    if (ctrl && key === 't')                  ks('new-tab');
    if (ctrl && input.shift && key === 'N')   ks('new-private-tab');
    if (ctrl && key === 'n' && !input.shift)  ks('new-window');
    if (ctrl && key === 'w')                  ks('close-tab');
    if (ctrl && key === 'l')                  ks('focus-omnibar');
    if (ctrl && key === 'f')                  ks('find');
    if (ctrl && key === 'd')                  ks('bookmark', { url: view.webContents.getURL(), title: view.webContents.getTitle() });
    if (ctrl && key === 'h')                  ks('history');
    if (ctrl && key === 'j')                  ks('downloads');
    if (ctrl && key === 'm')                  ks('mute-tab');
    if (ctrl && key === 'p')                  ks('pin-tab');
    if (ctrl && key === 'u')                  ks('reader-mode');
    if (key === 'Escape')                     ks('escape');
    if (key === 'F12')                        view.webContents.toggleDevTools();
    if (key === 'F5' || (ctrl && key === 'r')) { e.preventDefault(); view.webContents.reload(); }
    if (ctrl && input.shift && key === 'R')   { e.preventDefault(); view.webContents.reloadIgnoringCache(); }

    if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); const z=Math.min(view.webContents.getZoomFactor()+0.1,3); view.webContents.setZoomFactor(z); send('zoom-changed',{tabId,zoom:Math.round(z*100)}); }
    if (ctrl && key === '-')                  { e.preventDefault(); const z=Math.max(view.webContents.getZoomFactor()-0.1,0.3); view.webContents.setZoomFactor(z); send('zoom-changed',{tabId,zoom:Math.round(z*100)}); }
    if (ctrl && key === '0')                  { e.preventDefault(); view.webContents.setZoomFactor(1); send('zoom-changed',{tabId,zoom:100}); }
    if (ctrl && key>='1'&&key<='9')           ks('switch-tab', { index: parseInt(key)-1 });
    if (ctrl && key==='Tab'&&!input.shift)    ks('next-tab');
    if (ctrl && input.shift && key==='Tab')   ks('prev-tab');
    if (input.alt && key==='ArrowLeft'  && view.webContents.canGoBack())    { e.preventDefault(); view.webContents.goBack();    }
    if (input.alt && key==='ArrowRight' && view.webContents.canGoForward()) { e.preventDefault(); view.webContents.goForward(); }
  });

  // Handle about:blank and similar
  const loadUrl = (u) => {
    if (!u || u === 'nova://newtab') return;
    // Block the dev secret URL — never navigate to it, just ignore
    if (u.toLowerCase().includes('nova-d.access')) return;
    if (u === 'about:blank' || u.startsWith('about:')) {
      view.webContents.loadURL(u).catch(() => {});
    } else if (u.startsWith('view-source:')) {
      view.webContents.loadURL(u).catch(() => {});
    } else if (/^https?:\/\//i.test(u) || /^ftp:\/\//i.test(u)) {
      view.webContents.loadURL(u).catch(() => {});
    } else {
      view.webContents.loadURL(u).catch(() => {});
    }
  };
  // ── Dialog intercept from page (alert/confirm/prompt) ───────────────────
  // Electron fires 'dialog' event for window.alert/confirm/prompt from pages
  view.webContents.on('dialog', (event, dialogType, message, defaultValue, callback) => {
    // Forward to renderer to show our custom dialog UI
    send('dialog', { type: dialogType, msg: message, defaultVal: defaultValue || '', origin: view.webContents.getTitle() || '' });
    // We respond via IPC when user answers — handled below
    // Store callback for when renderer sends dialog-response
    ctx._pendingDialog = callback;
    event.preventDefault(); // prevent default Electron dialog
  });

  // ── beforeunload / will-prevent-unload ───────────────────────────────────
  view.webContents.on('will-prevent-unload', (event) => {
    send('dialog', { type: 'confirm', msg: 'Leave site? Changes you made may not be saved.', defaultVal: '', origin: view.webContents.getTitle() || 'This page' });
    // We'll allow unload by default unless user cancels
    ctx._preventingUnload = true;
    ctx._preventingUnloadTabId = tabId;
  });

  // ── New window / popup handler ────────────────────────────────────────────
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'new-tab' || disposition === 'foreground-tab') {
      send('open-url-new-tab', { url });
    } else if (disposition === 'background-tab') {
      send('open-url-new-tab', { url });
    } else {
      // popup — open as a new tab in Nova
      send('open-url-new-tab', { url });
    }
    return { action: 'deny' }; // always deny native popup, handle in renderer
  });

  // ── Permission request + check handlers ─────────────────────────────────────
  // setPermissionRequestHandler: called when site requests a permission
  // setPermissionCheckHandler:   called when site checks if permission is granted
  // Both are needed for YouTube autoplay, WebAuthn/passkeys, etc.
  const permSes = ctx.isPrivate ? ctx.session : session.defaultSession;

  permSes.setPermissionRequestHandler((wc, permission, callback, details) => {
    // Always grant these — needed for YouTube, passkeys, fullscreen etc.
    const alwaysGrant = [
      'fullscreen',               // YouTube fullscreen button
      'clipboard-sanitized-write',
      'accessibility-events',
      'media',                    // camera/mic (sites show their own UI)
      'geolocation',              // weather and maps
      'notifications',            // web push
      'pointerLock',              // games
      'openExternal',             // links
      'mediaKeySystem',           // DRM — needed for YouTube Premium, Netflix
      'webAuthentication',        // WebAuthn / Passkeys / FIDO2
    ];
    if (alwaysGrant.includes(permission)) return callback(true);
    callback(true); // grant everything else too for now
  });

  // Permission CHECK handler — checked BEFORE the request handler
  // Without this, YouTube and passkey sites silently fail
  permSes.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // Allow all permission checks — the actual grant happens in setPermissionRequestHandler
    return true;
  });

  // ── Certificate error ─────────────────────────────────────────────────────
  view.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
    event.preventDefault();
    // For non-critical errors (expired certs, mismatched names), allow through
    // YouTube and many CDNs use wildcard/intermediate certs that Electron rejects
    const nonCritical = [
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_CERT_COMMON_NAME_INVALID',
      'net::ERR_CERT_AUTHORITY_INVALID',
      'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM',
    ];
    if (nonCritical.includes(error)) {
      callback(true); // allow — same as ignore-certificate-errors flag
    } else {
      send('certificate-error', { url, error, tabId });
      callback(true); // allow and notify renderer
    }
  });

  // ── Media playback state ──────────────────────────────────────────────────
  view.webContents.on('media-started-playing', () => {
    send('tab-audio', { tabId, audible: true,  muted: view.webContents.isAudioMuted() });
  });
  view.webContents.on('media-paused', () => {
    send('tab-audio', { tabId, audible: false, muted: view.webContents.isAudioMuted() });
  });

  // ── Cursor change (for status bar) ────────────────────────────────────────
  view.webContents.on('cursor-changed', (event, type, image) => {
    if (type === 'pointer') send('cursor-changed', { cursor: 'pointer', tabId });
    else if (type === 'default') send('cursor-changed', { cursor: 'default', tabId });
  });

  // ── Reader mode availability ──────────────────────────────────────────────
  view.webContents.on('did-stop-loading', () => {
    // Check if the page has readable content (article-like)
    view.webContents.executeJavaScript(`
      (function(){
        const article = document.querySelector('article, [role="article"], .article, .post-content, main');
        const paragraphs = document.querySelectorAll('p');
        return !!(article || paragraphs.length > 3);
      })()
    `).then(readable => {
      send('reader-mode-changed', { tabId, available: readable });
    }).catch(() => {});
  });

  loadUrl(url);
  ctx.views.set(tabId, view);
  return view;
}

// ── Show / destroy ────────────────────────────────────────────────────────────
function showView(ctx, id) {
  ctx.views.forEach(v => ctx.mainWindow.removeBrowserView(v));
  if (id && ctx.views.has(id)) {
    ctx.mainWindow.addBrowserView(ctx.views.get(id));
    ctx.activeViewId = id;
    const v = ctx.views.get(id);
    v.setBounds(getContentBounds(ctx, ctx.splitActive ? 'left' : 'full'));
    sendNavState(ctx, id, v);
  } else {
    ctx.activeViewId = null;
  }
  // Re-add secondary split view on top if active
  if (ctx.splitActive && ctx.splitSecondaryId && ctx.views.has(ctx.splitSecondaryId)) {
    const sv = ctx.views.get(ctx.splitSecondaryId);
    ctx.mainWindow.addBrowserView(sv);
    sv.setBounds(getContentBounds(ctx, 'right'));
  }
}
function destroyView(ctx, id) {
  const v = ctx.views.get(id);
  if (v) { ctx.mainWindow.removeBrowserView(v); v.webContents.destroy(); ctx.views.delete(id); }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function takeScreenshot(ctx, tabId) {
  const v = ctx.views.get(tabId); if (!v) return;
  try {
    const img  = await v.webContents.capturePage();
    const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,-5);
    const file = path.join(DL_DIR, `nova-screenshot-${ts}.png`);
    fs.writeFileSync(file, img.toPNG());
    ctx.mainWindow.webContents.send('screenshot-saved', { path: file });
  } catch (err) { console.error('Screenshot error:', err); }
}

// ── History ───────────────────────────────────────────────────────────────────
function pushHistory(url, title, favicon) {
  history = history.filter(h => h.url !== url);
  history.unshift({ url, title: title || url, favicon, ts: Date.now() });
  if (history.length > 2000) history.length = 2000;
  writeJ(HIST_FILE, history);
  windowContexts.forEach(ctx => {
    if (!ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('history-updated', history.slice(0, 100));
  });
}

// ── Extensions ────────────────────────────────────────────────────────────────
async function loadSavedExtensions() {
  loadedExts = [];
  for (const ext of savedExts) {
    try {
      const loaded = await session.defaultSession.loadExtension(ext.path, { allowFileAccess: true });
      loadedExts.push({ id: loaded.id, name: loaded.name, version: loaded.version || '?', path: ext.path, enabled: true });
    } catch (err) { console.warn('[Nova] Failed to load ext:', ext.path, err.message); }
  }
}

// ── Reader mode ───────────────────────────────────────────────────────────────
ipcMain.on('reader-mode', async (e, { tabId }) => {
  const ctx = getCtx(e.sender); const v = ctx?.views.get(tabId); if (!v) return;
  if (v._readerMode) {
    v._readerMode = false;
    v.webContents.reload();
    ctx.mainWindow.webContents.send('reader-mode-changed', { tabId, on: false });
  } else {
    v._readerMode = true;
    ctx.mainWindow.webContents.send('reader-mode-changed', { tabId, on: true });
    await v.webContents.executeJavaScript(`
      (function(){
        const t=document.title;
        const content=(document.querySelector('article')||document.querySelector('[role="main"]')||document.querySelector('main')||document.querySelector('.content,.post,.article,.entry,#content,#main')||document.body);
        const html=content?content.innerHTML:document.body.innerHTML;
        document.open();document.write(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>\${t}</title>
        <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#f9f6f0;color:#1a1a1a;font-family:Georgia,serif;font-size:18px;line-height:1.8;padding:56px 20px 40px;max-width:740px;margin:0 auto}h1,h2,h3{font-family:system-ui;line-height:1.3;margin:1.4em 0 .5em}h1{font-size:2em}p{margin-bottom:1.2em}img{max-width:100%;border-radius:6px;margin:1em 0}a{color:#4f46e5}blockquote{border-left:4px solid #ccc;padding-left:1em;color:#555;font-style:italic;margin:1em 0}pre,code{background:#f0f0f0;border-radius:4px;padding:2px 6px;font-family:monospace;font-size:.85em}pre{padding:1em;overflow-x:auto}ul,ol{padding-left:1.5em;margin-bottom:1em}#__nb{position:fixed;top:0;left:0;right:0;background:#f9f6f0;border-bottom:1px solid #ddd;padding:8px 20px;font-family:system-ui;font-size:13px;display:flex;align-items:center;gap:12px;z-index:9999}#__nb strong{font-size:13px}</style>
        </head><body><div id="__nb">📖 <strong>Reader Mode</strong><span style="opacity:.4">·</span><span style="opacity:.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${t}</span></div>\${html}</body></html>\`);document.close();
      })();
    `).catch(() => {});
  }
});

// ── Picture-in-Picture ────────────────────────────────────────────────────────
ipcMain.on('picture-in-picture', async (e, { tabId }) => {
  const ctx = getCtx(e.sender); const v = ctx?.views.get(tabId); if (!v) return;
  await v.webContents.executeJavaScript(`(function(){const vid=document.querySelector('video');if(vid){if(document.pictureInPictureElement)document.exitPictureInPicture();else vid.requestPictureInPicture().catch(()=>alert('PiP not supported on this page'));}else alert('No video found on this page');})();`).catch(()=>{});
});

// ── Error page ───────────────────────────────────────────────────────────────
function generateErrorPage(code, desc, url) {
  let host = url; try { host = new URL(url).hostname; } catch {}
  const msgs = {
    '-2':   ['The page took too long to respond', 'ERR_FAILED'],
    '-6':   ['The connection was refused', 'ERR_CONNECTION_REFUSED'],
    '-7':   ['The connection was reset', 'ERR_CONNECTION_RESET'],
    '-15':  ['Could not resolve the host name', 'ERR_NAME_NOT_RESOLVED'],
    '-21':  ['Network change detected', 'ERR_NETWORK_CHANGED'],
    '-100': ['Connection refused', 'ERR_CONNECTION_REFUSED'],
    '-101': ['Connection reset', 'ERR_CONNECTION_RESET'],
    '-102': ['Connection refused', 'ERR_CONNECTION_REFUSED'],
    '-105': ['DNS lookup failed', 'ERR_NAME_NOT_RESOLVED'],
    '-106': ['Internet connection offline', 'ERR_INTERNET_DISCONNECTED'],
    '-109': ['Address unreachable', 'ERR_ADDRESS_UNREACHABLE'],
    '-118': ['Connection timed out', 'ERR_CONNECTION_TIMED_OUT'],
    '-137': ['Network access denied', 'ERR_NETWORK_ACCESS_DENIED'],
    '-200': ['Certificate error', 'ERR_CERT_COMMON_NAME_INVALID'],
    '-501': ['Insecure connection blocked', 'ERR_INSECURE_RESPONSE'],
  };
  const [friendly, errName] = msgs[String(code)] || ['This page could not be loaded', desc || 'ERR_FAILED'];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Page unavailable</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#13131a;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:520px;width:100%;text-align:center}
.orb{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,rgba(239,68,68,.25),rgba(239,68,68,.1));border:1px solid rgba(239,68,68,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
h1{font-size:22px;font-weight:700;margin-bottom:8px;color:#f1f5f9}
.sub{font-size:14px;color:#94a3b8;margin-bottom:6px;line-height:1.6}
.host{font-size:13px;font-weight:600;color:#818cf8;margin-bottom:24px;word-break:break-all}
.err{font-size:11px;font-family:monospace;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 14px;color:#64748b;margin-bottom:24px;display:inline-block}
.btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
button{padding:9px 20px;border-radius:9px;border:1px solid rgba(255,255,255,.12);cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;transition:.15s}
.primary{background:#818cf8;color:#fff;border-color:#818cf8}.primary:hover{opacity:.88}
.secondary{background:rgba(255,255,255,.07);color:#94a3b8}.secondary:hover{background:rgba(255,255,255,.12);color:#e2e8f0}
</style></head><body><div class="card">
<div class="orb"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round"><circle cx="16" cy="16" r="13"/><line x1="16" y1="9" x2="16" y2="17"/><circle cx="16" cy="22" r="1.2" fill="#ef4444" stroke="none"/></svg></div>
<h1>Page unavailable</h1>
<div class="sub">${friendly}</div>
<div class="host">${host}</div>
<div class="err">Error code: ${errName} (${code})</div>
<div class="btns">
  <button class="primary" onclick="history.back()">← Go Back</button>
  <button class="secondary" onclick="location.href='${url.replace(/'/g,"\'")}'"  >↻ Try Again</button>
</div></div></body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// IPC
// ══════════════════════════════════════════════════════════════════════════════

// Tabs
ipcMain.on('tab-created',   (e, { tabId, url }) => {
  const ctx = getCtx(e.sender); if (!ctx) return;
  if (url && url !== 'nova://newtab' && isSafeURL(url)) createView(ctx, tabId, url);
});
ipcMain.on('tab-closed',    (e, { tabId }) => { const ctx=getCtx(e.sender); if(ctx) destroyView(ctx,tabId); });
ipcMain.on('tab-selected',  (e, { tabId, url }) => {
  const ctx=getCtx(e.sender); if(!ctx) return;
  if(!url||url==='nova://newtab'||url==='about:newtab') showView(ctx,null);
  else { if(!ctx.views.has(tabId)) createView(ctx,tabId,url); showView(ctx,tabId); }
});
ipcMain.on('navigate', (e, { tabId, url }) => {
  const ctx=getCtx(e.sender); if(!ctx) return;
  const v=ctx.views.get(tabId);
  if(!v) { createView(ctx,tabId,url); showView(ctx,tabId); }
  else {
    if(url==='about:blank'||url.startsWith('about:')||isSafeURL(url))
      v.webContents.loadURL(url).catch(()=>{});
    showView(ctx,tabId);
  }
});
ipcMain.on('go-back',      (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v?.webContents.canGoBack())    v.webContents.goBack();    });
ipcMain.on('go-forward',   (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v?.webContents.canGoForward()) v.webContents.goForward(); });
ipcMain.on('reload',       (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.reload(); });
ipcMain.on('reload-hard',  (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.reloadIgnoringCache(); });
ipcMain.on('stop-loading', (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.stop(); });

// Window
ipcMain.on('win-minimize', e => { getCtx(e.sender)?.mainWindow.minimize(); });
ipcMain.on('win-maximize', e => { const w=getCtx(e.sender)?.mainWindow; if(w) w.isMaximized()?w.unmaximize():w.maximize(); });
ipcMain.on('win-close',    e => { getCtx(e.sender)?.mainWindow.close(); });
ipcMain.on('new-window',   (e, { isPrivate }) => createWindow(isPrivate||false));
// ── Split screen IPC ──────────────────────────────────────────────────────────
ipcMain.on('split-open', (e, { primaryTabId, secondaryTabId }) => {
  const ctx = getCtx(e.sender); if (!ctx) return;
  ctx.splitActive = true;
  ctx.splitSecondaryId = secondaryTabId;
  // Create secondary view if needed
  if (!ctx.views.has(secondaryTabId)) createView(ctx, secondaryTabId, 'nova://newtab');
  repositionView(ctx);
  // Show secondary view
  const sv = ctx.views.get(secondaryTabId);
  if (sv) { ctx.mainWindow.addBrowserView(sv); sv.setBounds(getContentBounds(ctx,'right')); }
});
ipcMain.on('split-close', (e) => {
  const ctx = getCtx(e.sender); if (!ctx) return;
  ctx.splitActive = false;
  ctx.splitSecondaryId = null;
  repositionView(ctx);
  // Remove secondary views from window
  ctx.mainWindow.webContents; // ensure not destroyed
  ctx.views.forEach((v, id) => {
    if (id !== ctx.activeViewId) ctx.mainWindow.removeBrowserView(v);
  });
  if (ctx.activeViewId && ctx.views.has(ctx.activeViewId)) {
    ctx.mainWindow.addBrowserView(ctx.views.get(ctx.activeViewId));
  }
});
ipcMain.on('split-resize', (e, { dx }) => {
  const ctx = getCtx(e.sender); if (!ctx || !ctx.splitActive) return;
  const [w] = ctx.mainWindow.getContentSize();
  const curLeftW = (w - 4) * (ctx.splitRatio || 0.5);
  const newLeftW = Math.max(200, Math.min(w - 204, curLeftW + dx));
  ctx.splitRatio = newLeftW / (w - 4);
  repositionView(ctx);
});
ipcMain.on('split-navigate', (e, { url }) => {
  const ctx = getCtx(e.sender); if (!ctx || !ctx.splitSecondaryId) return;
  const sv = ctx.views.get(ctx.splitSecondaryId);
  if (sv && url) sv.webContents.loadURL(url).catch(() => {});
});
ipcMain.on('suspend-tab', (e, { tabId }) => {
  const ctx = getCtx(e.sender); const v = ctx?.views.get(tabId);
  if (v && tabId !== ctx.activeViewId) v.webContents.setBackgroundThrottling(true);
});
ipcMain.on('wake-tab', (e, { tabId }) => {
  const ctx = getCtx(e.sender); const v = ctx?.views.get(tabId);
  if (v) v.webContents.setBackgroundThrottling(false);
});

// Fullscreen toggle (F11)
ipcMain.on('toggle-fullscreen', (e) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  const win = ctx.mainWindow;
  const going = !win.isFullScreen();
  win.setFullScreen(going);
  // Notify renderer — handled by win events below
});


// ══════════════════════════════════════════════════════════════════════════════
// NOVA VPN — Proxy routing via Electron session.setProxy()
// Routes ALL BrowserView network traffic through the selected SOCKS5 proxy.
// Uses Electron's built-in Chromium proxy stack — no external libraries needed.
// ══════════════════════════════════════════════════════════════════════════════

// Track VPN state per window context
const vpnState = new Map(); // ctxId → { active, proxy, country }

ipcMain.handle('vpn-connect', async (e, { proxy, country }) => {
  const ctx = getCtx(e.sender);
  if (!ctx) return { ok: false, error: 'No context' };

  // proxy format: "socks5://host:port"
  // We test the proxy by attempting to set it and making a probe request
  const proxyConfig = {
    proxyRules: proxy.replace('socks5://', 'socks5='),
    proxyBypassRules: 'localhost,127.0.0.1,::1',
  };

  try {
    // Apply to the session used by this window's BrowserViews
    const ses = ctx.isPrivate ? ctx.session : session.defaultSession;
    await ses.setProxy(proxyConfig);

    // Verify the proxy works by probing a fast IP check endpoint
    const probeOk = await new Promise((resolve) => {
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      const timer = setTimeout(() => finish(false), 8000);
      try {
        const req = net.request({ url: 'https://api.ipify.org?format=json', session: ses });
        req.on('response', res => { clearTimeout(timer); finish(res.statusCode === 200); });
        req.on('error', () => { clearTimeout(timer); finish(false); });
        req.end();
      } catch(e) { clearTimeout(timer); finish(false); }
    });

    if (!probeOk) {
      // Proxy didn't work — reset to direct
      await ses.setProxy({ proxyRules: 'direct://' });
      return { ok: false, error: 'Proxy unreachable' };
    }

    // Success — store state
    vpnState.set(ctx.id, { active: true, proxy, country });

    // Notify renderer
    if (!ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('vpn-state-changed', { active: true, country });
    }

    console.log(`[Nova VPN] Connected via ${proxy} (${country})`);
    return { ok: true };

  } catch (err) {
    console.error('[Nova VPN] Error:', err.message);
    // Reset proxy on error
    try {
      const ses = ctx.isPrivate ? ctx.session : session.defaultSession;
      await ses.setProxy({ proxyRules: 'direct://' });
    } catch {}
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vpn-disconnect', async (e) => {
  const ctx = getCtx(e.sender);
  if (!ctx) return { ok: false };
  try {
    const ses = ctx.isPrivate ? ctx.session : session.defaultSession;
    // Reset to direct connection (no proxy)
    await ses.setProxy({ proxyRules: 'direct://' });
    vpnState.delete(ctx.id);
    console.log('[Nova VPN] Disconnected — direct connection restored');
    if (!ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('vpn-state-changed', { active: false });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vpn-get-state', (e) => {
  const ctx = getCtx(e.sender);
  if (!ctx) return { active: false };
  return vpnState.get(ctx.id) || { active: false };
});

// Ensure VPN is disconnected when window closes
// (handled by win.on('closed') → windowContexts.delete, but also reset proxy)
// ── Panel overlay IPC — push BrowserView down when HTML panels open ─────────
// BrowserView is a native layer above HTML; panels must be in uncovered area
// ── Page dialog from BrowserView (via preload-page.js) ────────────────────────
// Receives alert/confirm/prompt from web pages and forwards to renderer
ipcMain.on('page-dialog', (e, { id, type, msg, defaultVal }) => {
  // Find which window context this BrowserView belongs to
  let ctx = null;
  let tabId = null;
  windowContexts.forEach(c => {
    c.views.forEach((v, tid) => {
      if (v.webContents === e.sender) { ctx = c; tabId = tid; }
    });
  });
  if (!ctx) return;

  // Get origin from the page URL
  let origin = '';
  try { origin = new URL(e.sender.getURL()).hostname; } catch {}

  // Store the sender so we can reply
  ctx._dlgSender  = e.sender;
  ctx._dlgId      = id;

  // Forward to renderer (main window) to show the custom dialog UI
  ctx.mainWindow.webContents.send('page-dialog-show', { id, type, msg, defaultVal, origin, tabId });
});


// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH — Opens a dedicated BrowserWindow for Google sign-in
// Avoids "requested action is invalid" from file:// redirect URIs
// Flow: main creates a popup → loads Google OAuth → intercepts redirect →
//       extracts ID token → sends back to renderer → signInWithCredential
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// PASSKEY / WEBAUTHN — Windows Hello, Touch ID, FIDO2 security keys
// Chromium handles the actual cryptographic operations natively.
// We just need to ensure permissions are granted and show UI feedback.
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('passkey-check-support', async () => {
  return { supported: true, platform: process.platform };
});

ipcMain.handle('open-google-auth', async (e) => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 500, height: 680, title: 'Sign in with Google',
      show: true, modal: false, center: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Build the Firebase auth URL that handles Google OAuth
    const authUrl = 'https://nova-browser-1b7b4.firebaseapp.com/__/auth/handler?' +
      new URLSearchParams({
        apiKey: 'AIzaSyA3fZnbyhG6ZW7iVT1EypSadeT2aUO0Jco',
        appName: '[DEFAULT]',
        authType: 'signInViaPopup',
        redirectUrl: 'https://nova-browser-1b7b4.firebaseapp.com/__/auth/handler',
        providerId: 'google.com',
        scopes: 'profile,email',
        eventId: Date.now().toString(),
        v: '10.7.1',
      }).toString();

    authWin.loadURL(authUrl);

    // Intercept navigation to catch the token in the redirect
    authWin.webContents.on('did-navigate', (ev, url) => {
      if (url.includes('access_token') || url.includes('id_token')) {
        try {
          const params = new URL(url.includes('#') ? url.replace('#', '?') : url).searchParams;
          const idToken = params.get('id_token');
          const accessToken = params.get('access_token');
          if (idToken || accessToken) {
            authWin.close();
            resolve({ idToken, accessToken });
            return;
          }
        } catch {}
      }
      // Firebase auth handler finishes — try to extract token from page
      if (url.includes('firebaseapp.com/__/auth/handler')) {
        setTimeout(() => {
          authWin.webContents.executeJavaScript(`
            (function(){
              try {
                const data = JSON.parse(window.__firestoreTokens || '{}');
                return data;
              } catch { return null; }
            })()
          `).then(data => {
            if (data?.idToken) { authWin.close(); resolve(data); }
          }).catch(() => {});
        }, 1500);
      }
    });

    // If user closes the window without signing in
    authWin.on('closed', () => resolve(null));

    // Timeout after 5 minutes
    setTimeout(() => { try { authWin.close(); } catch {} resolve(null); }, 300000);
  });
});

// ── Dialog visibility: hide BrowserView while dialog is showing ──────────────
// Since BrowserView is a native OS layer above ALL HTML, we must move it
// completely below the visible area while dialogs, auth modals, etc. are showing.
ipcMain.on('overlay-show', (e) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  ctx._overlayOpen = true;
  // Move BrowserView completely off-screen (below the window)
  ctx.views.forEach(v => {
    try {
      const [w, h] = ctx.mainWindow.getContentSize();
      v.setBounds({ x: 0, y: h + 100, width: w, height: 100 });
    } catch(err) {}
  });
});
ipcMain.on('overlay-hide', (e) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  ctx._overlayOpen = false;
  repositionView(ctx); // restore normal position
});

// ── Dialog response from renderer ────────────────────────────────────────────
ipcMain.on('dialog-response', (e, { id, result }) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  // Legacy pending dialog callback
  if (ctx._pendingDialog) { ctx._pendingDialog(result); ctx._pendingDialog = null; }
  if (ctx._preventingUnload) { ctx._preventingUnload = false; }
  // Reply to the BrowserView preload-page.js that is waiting for the response
  if (ctx._dlgSender && !ctx._dlgSender.isDestroyed()) {
    ctx._dlgSender.send('page-dialog-response', { id: id || ctx._dlgId, result });
    ctx._dlgSender = null; ctx._dlgId = null;
  }
});

// ── Permission response ───────────────────────────────────────────────────────
ipcMain.on('permission-response', (e, { permission, granted }) => {
  // Future: map back to pending permission callbacks
});

ipcMain.on('resize-sidebar', (e, { sidebarWidth }) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  ctx.sidebarWidth = Math.max(0, sidebarWidth || 0);
  repositionView(ctx);
});

ipcMain.on('panel-open',  (e, { height }) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  ctx.panelExtraTop = Math.max(0, (height||0) + 4);
  repositionView(ctx);
});
ipcMain.on('panel-close', (e) => {
  const ctx = getCtx(e.sender); if(!ctx) return;
  ctx.panelExtraTop = 0;
  repositionView(ctx);
});
ipcMain.on('resize-view',    (e, { extraTop }) => { const ctx=getCtx(e.sender); if(!ctx) return; ctx.viewExtraTop=extraTop||0; repositionView(ctx); });
ipcMain.on('set-chrome-height', (e, { height }) => { const ctx=getCtx(e.sender); if(!ctx) return; ctx.chromeHeight=Math.max(60,Math.min(height,220)); repositionView(ctx); });

// Tab detach: create new window with the tab's URL
ipcMain.on('detach-tab', (e, { url, x, y }) => {
  if (!url || url === 'nova://newtab') return;
  const ctx = getCtx(e.sender);
  createWindow(ctx?.isPrivate||false, url, { x: Math.round(x)-100, y: Math.round(y)-15 });
});

// Mute
ipcMain.on('mute-tab', (e, { tabId, muted }) => {
  const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(!v) return;
  v.webContents.setAudioMuted(muted);
  ctx.mainWindow.webContents.send('nav-state', { tabId, isMuted: muted });
});

// Screenshot
ipcMain.on('screenshot', (e, { tabId }) => { const ctx=getCtx(e.sender); if(ctx) takeScreenshot(ctx,tabId); });

// Site info for lock popup
ipcMain.handle('get-site-info', (e, { tabId }) => {
  const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(!v) return null;
  const url = v.webContents.getURL();
  try {
    const u = new URL(url);
    return { url, host: u.hostname, protocol: u.protocol, secure: u.protocol==='https:', origin: u.origin };
  } catch { return { url, host: url, protocol: '', secure: false, origin: url }; }
});

// Search suggestions via Google Suggest
ipcMain.handle('get-suggestions', async (e, { query }) => {
  if (!query || query.length < 2) return [];
  return new Promise(resolve => {
    const req = net.request({
      method: 'GET',
      url: `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
    });
    let data = '';
    req.on('response', res => {
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)[1].slice(0,6)); } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
});

// History
ipcMain.handle('get-history',       () => history.slice(0,500));
ipcMain.on('clear-history',         () => { history=[]; writeJ(HIST_FILE,[]); broadcast('history-updated',[]); });
ipcMain.on('delete-history-item',   (e,{url}) => { history=history.filter(h=>h.url!==url); writeJ(HIST_FILE,history); });

// Bookmarks
ipcMain.handle('get-bookmarks', () => bookmarks);
ipcMain.on('add-bookmark',    (e, { url, title, favicon }) => {
  if (!bookmarks.find(b=>b.url===url)) { bookmarks.unshift({url,title:title||url,favicon,ts:Date.now()}); writeJ(BM_FILE,bookmarks); broadcast('bookmarks-updated',bookmarks); }
});
ipcMain.on('remove-bookmark', (e, { url }) => { bookmarks=bookmarks.filter(b=>b.url!==url); writeJ(BM_FILE,bookmarks); broadcast('bookmarks-updated',bookmarks); });

// Find
ipcMain.on('find-in-page', (e,{tabId,text,forward,findNext}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v&&text) v.webContents.findInPage(text,{forward:forward!==false,findNext:!!findNext}); });
ipcMain.on('stop-finding', (e,{tabId}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.stopFindInPage('clearSelection'); });

// Zoom
ipcMain.on('set-zoom', (e,{tabId,factor}) => { const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(!v) return; v.webContents.setZoomFactor(factor); ctx.mainWindow.webContents.send('zoom-changed',{tabId,zoom:Math.round(factor*100)}); });

// Downloads
ipcMain.on('open-devtools', (e, { tabId }) => {
  const ctx = getCtx(e.sender); const v = ctx?.views.get(tabId);
  if (v) v.webContents.openDevTools();
});
ipcMain.on('print-page',  (e,{tabId})=>{ const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.print(); });
ipcMain.on('save-page',   (e,{tabId})=>{ const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(v) v.webContents.savePage(require('path').join(DL_DIR,'page-'+Date.now()+'.html'),'HTMLComplete').catch(()=>{}); });
ipcMain.handle('execute-script', async (e,{tabId,code})=>{ const ctx=getCtx(e.sender); const v=ctx?.views.get(tabId); if(!v) return null; try{ return await v.webContents.executeJavaScript(code); }catch(err){ return null; } });
ipcMain.on('open-external', (e, { url }) => { if(url && /^https?:\/\//i.test(url)) shell.openExternal(url).catch(()=>{}); });
ipcMain.on('open-downloads-folder', () => shell.openPath(DL_DIR));
ipcMain.on('open-file',             (e,{filePath}) => shell.openPath(filePath));
ipcMain.handle('get-downloads',     () => [...dlMap.values()]);

// Extensions
ipcMain.handle('pick-extension-folder', async e => {
  const ctx=getCtx(e.sender);
  return dialog.showOpenDialog(ctx?.mainWindow, { properties:['openDirectory'], title:'Select Unpacked Extension Folder' });
});
ipcMain.handle('load-extension', async (e, { extPath }) => {
  try {
    const loaded = await session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
    const extInfo = { id: loaded.id, name: loaded.name, version: loaded.version||'?', path: extPath, enabled: true };
    if (!savedExts.find(x=>x.path===extPath)) { savedExts.push({path:extPath}); writeJ(EXT_FILE,savedExts); }
    if (!loadedExts.find(x=>x.id===loaded.id)) loadedExts.push(extInfo);
    broadcast('extensions-updated', loadedExts);
    return { success: true, ext: extInfo };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.on('remove-extension', async (e, { extId, extPath }) => {
  try { await session.defaultSession.removeExtension(extId); } catch {}
  loadedExts = loadedExts.filter(x=>x.id!==extId);
  savedExts  = savedExts.filter(x=>x.path!==extPath);
  writeJ(EXT_FILE, savedExts);
  broadcast('extensions-updated', loadedExts);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Block trackers on default session
  session.defaultSession.webRequest.onBeforeRequest({ urls:['*://*/*'] }, (details, cb) => {
    // Block the Nova dev secret URL at network level
    if (details.url.toLowerCase().includes('nova-d.access')) return cb({ cancel: true });
    if (isBlocked(details.url)) { blockedCount++; broadcast('blocked-count',blockedCount); return cb({cancel:true}); }
    cb({});
  });
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const h = { ...details.responseHeaders };
    delete h['x-frame-options']; delete h['X-Frame-Options'];
    cb({ responseHeaders: h });
  });
  // Strip Electron from outgoing requests
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls:['*://*/*'] }, (details, cb) => {
    const h = { ...details.requestHeaders };
    if (h['User-Agent']) h['User-Agent'] = h['User-Agent'].replace(/\s*Electron\/[\d.]+/g,'');
    cb({ requestHeaders: h });
  });
  // Downloads
  session.defaultSession.on('will-download', (e, item) => {
    const id=++dlId, filename=item.getFilename(), savePath=path.join(DL_DIR,filename);
    item.setSavePath(savePath);
    const info = { id, filename, url:item.getURL(), path:savePath, size:item.getTotalBytes(), received:0, state:'progressing' };
    dlMap.set(id, info);
    broadcast('download-started', info);
    item.on('updated', () => { info.received=item.getReceivedBytes(); broadcast('download-progress',{id,received:info.received,size:info.size}); });
    item.on('done', (e, state) => { info.state=state; info.received=item.getReceivedBytes(); broadcast('download-complete',{id,state,path:savePath,filename}); });
  });

  await loadSavedExtensions();

  // Auto-load Nova Shield if the folder exists next to main.js
  const ADBLOCKER_PATH = path.join(__dirname, 'nova-adblocker');
  if (fs.existsSync(path.join(ADBLOCKER_PATH, 'manifest.json'))) {
    try {
      const loaded = await session.defaultSession.loadExtension(ADBLOCKER_PATH, { allowFileAccess: true });
      if (!loadedExts.find(x => x.id === loaded.id))
        loadedExts.push({ id: loaded.id, name: loaded.name, version: loaded.version || '?', path: ADBLOCKER_PATH, enabled: true });
      console.log('[Nova Shield] Auto-loaded:', loaded.name);
    } catch (err) { console.warn('[Nova Shield] Auto-load failed:', err.message); }
  }

  createWindow(false);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate',          () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(false); });