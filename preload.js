const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaBridge', {
  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabCreated:          d => ipcRenderer.send('tab-created',         d),
  tabSelected:         d => ipcRenderer.send('tab-selected',        d),
  tabClosed:           d => ipcRenderer.send('tab-closed',          d),
  navigate:            d => ipcRenderer.send('navigate',            d),
  goBack:              d => ipcRenderer.send('go-back',             d),
  goForward:           d => ipcRenderer.send('go-forward',          d),
  reload:              d => ipcRenderer.send('reload',              d),
  reloadHard:          d => ipcRenderer.send('reload-hard',         d),
  stopLoading:         d => ipcRenderer.send('stop-loading',        d),

  // ── Window ────────────────────────────────────────────────────────────────
  winMinimize:         () => ipcRenderer.send('win-minimize'),
  winMaximize:         () => ipcRenderer.send('win-maximize'),
  winClose:            () => ipcRenderer.send('win-close'),
  newWindow:           d  => ipcRenderer.send('new-window',         d),
  resizeView:          d  => ipcRenderer.send('resize-view',        d),
  setChromeHeight:     d  => ipcRenderer.send('set-chrome-height',  d),
  detachTab:           d  => ipcRenderer.send('detach-tab',         d),
  toggleFullscreen:    () => ipcRenderer.send('toggle-fullscreen'),
  openExternal:        d  => ipcRenderer.send('open-external',      d),

  // ── Tab features ──────────────────────────────────────────────────────────
  muteTab:             d => ipcRenderer.send('mute-tab',            d),
  screenshot:          d => ipcRenderer.send('screenshot',          d),
  readerMode:          d => ipcRenderer.send('reader-mode',         d),
  pictureInPicture:    d => ipcRenderer.send('picture-in-picture',  d),
  printPage:           d => ipcRenderer.send('print-page',          d),
  savePage:            d => ipcRenderer.send('save-page',           d),
  executeScript:       d => ipcRenderer.invoke('execute-script',    d),
  openDevTools:        d => ipcRenderer.send('open-devtools',       d),

  // ── History ───────────────────────────────────────────────────────────────
  getHistory:          () => ipcRenderer.invoke('get-history'),
  clearHistory:        () => ipcRenderer.send('clear-history'),
  deleteHistoryItem:   d  => ipcRenderer.send('delete-history-item', d),

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  getBookmarks:        () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark:         d  => ipcRenderer.send('add-bookmark',       d),
  removeBookmark:      d  => ipcRenderer.send('remove-bookmark',    d),

  // ── Find ──────────────────────────────────────────────────────────────────
  findInPage:          d => ipcRenderer.send('find-in-page',        d),
  stopFinding:         d => ipcRenderer.send('stop-finding',        d),

  // ── Zoom ──────────────────────────────────────────────────────────────────
  setZoom:             d => ipcRenderer.send('set-zoom',            d),

  // ── Downloads ─────────────────────────────────────────────────────────────
  openDownloadsFolder: () => ipcRenderer.send('open-downloads-folder'),
  openFile:            d  => ipcRenderer.send('open-file',          d),
  getDownloads:        () => ipcRenderer.invoke('get-downloads'),

  // ── Extensions ───────────────────────────────────────────────────────────
  pickExtensionFolder: () => ipcRenderer.invoke('pick-extension-folder'),
  loadExtension:       d  => ipcRenderer.invoke('load-extension',   d),
  removeExtension:     d  => ipcRenderer.send('remove-extension',   d),

  // ── Site info / suggestions ───────────────────────────────────────────────
  getSiteInfo:         d => ipcRenderer.invoke('get-site-info',     d),
  getSuggestions:      d => ipcRenderer.invoke('get-suggestions',   d),

  // ── Split screen ──────────────────────────────────────────────────────────
  // Passkey / WebAuthn
  passkeyCheckSupport:  () => ipcRenderer.invoke('passkey-check-support'),
  // Sidebar
  resizeSidebar:       d => ipcRenderer.send('resize-sidebar',     d),
  // Google OAuth
  openGoogleAuth:      () => ipcRenderer.invoke('open-google-auth'),
  // Overlay (hides BrowserView when dialogs/modals open)
  overlayShow:         () => ipcRenderer.send('overlay-show'),
  overlayHide:         () => ipcRenderer.send('overlay-hide'),
  // VPN
  vpnConnect:          d => ipcRenderer.invoke('vpn-connect',         d),
  vpnDisconnect:       () => ipcRenderer.invoke('vpn-disconnect'),
  vpnGetState:         () => ipcRenderer.invoke('vpn-get-state'),
  onVpnStateChanged:   cb => ipcRenderer.on('vpn-state-changed',     (e,d)=>cb(d)),
  // Panel overlay
  panelOpen:           d => ipcRenderer.send('panel-open',          d),
  panelClose:          () => ipcRenderer.send('panel-close'),
  splitOpen:           d => ipcRenderer.send('split-open',          d),
  splitClose:          d => ipcRenderer.send('split-close',         d),
  splitResize:         d => ipcRenderer.send('split-resize',        d),
  splitNavigate:       d => ipcRenderer.send('split-navigate',      d),

  // ── Tab sleep ────────────────────────────────────────────────────────────
  suspendTab:          d => ipcRenderer.send('suspend-tab',         d),
  wakeTab:             d => ipcRenderer.send('wake-tab',            d),

  // ── Listeners ─────────────────────────────────────────────────────────────
  onInit:              cb => ipcRenderer.on('init',                  (e,d)=>cb(d)),
  onTabNavigated:      cb => ipcRenderer.on('tab-navigated',         (e,d)=>cb(d)),
  onTabTitleUpdated:   cb => ipcRenderer.on('tab-title-updated',     (e,d)=>cb(d)),
  onTabFavicon:        cb => ipcRenderer.on('tab-favicon-updated',   (e,d)=>cb(d)),
  onTabLoading:        cb => ipcRenderer.on('tab-loading',           (e,d)=>cb(d)),
  onTabAudio:          cb => ipcRenderer.on('tab-audio',             (e,d)=>cb(d)),
  onTabLoadError:      cb => ipcRenderer.on('tab-load-error',        (e,d)=>cb(d)),
  onNavState:          cb => ipcRenderer.on('nav-state',             (e,d)=>cb(d)),
  onKeyboardShortcut:  cb => ipcRenderer.on('keyboard-shortcut',     (e,d)=>cb(d)),
  onHistoryUpdated:    cb => ipcRenderer.on('history-updated',       (e,d)=>cb(d)),
  onBookmarksUpdated:  cb => ipcRenderer.on('bookmarks-updated',     (e,d)=>cb(d)),
  onDownloadStarted:   cb => ipcRenderer.on('download-started',      (e,d)=>cb(d)),
  onDownloadProgress:  cb => ipcRenderer.on('download-progress',     (e,d)=>cb(d)),
  onDownloadComplete:  cb => ipcRenderer.on('download-complete',     (e,d)=>cb(d)),
  onFindResult:        cb => ipcRenderer.on('find-result',           (e,d)=>cb(d)),
  onZoomChanged:       cb => ipcRenderer.on('zoom-changed',          (e,d)=>cb(d)),
  onBlockedCount:      cb => ipcRenderer.on('blocked-count',         (e,d)=>cb(d)),
  onWinState:          cb => ipcRenderer.on('win-state',             (e,d)=>cb(d)),
  onOpenUrlNewTab:     cb => ipcRenderer.on('open-url-new-tab',      (e,d)=>cb(d)),
  onOpenUrlPrivateTab: cb => ipcRenderer.on('open-url-private-tab',  (e,d)=>cb(d)),
  onScreenshotSaved:   cb => ipcRenderer.on('screenshot-saved',      (e,d)=>cb(d)),
  onReaderModeChanged: cb => ipcRenderer.on('reader-mode-changed',   (e,d)=>cb(d)),
  onExtensionsUpdated: cb => ipcRenderer.on('extensions-updated',    (e,d)=>cb(d)),
  onFullscreenChange:  cb => ipcRenderer.on('fullscreen-change',     (e,d)=>cb(d)),
  onPermissionRequest: cb => ipcRenderer.on('permission-request',   (e,d)=>cb(d)),
  onCertificateError:  cb => ipcRenderer.on('certificate-error',    (e,d)=>cb(d)),
  onCursorChanged:     cb => ipcRenderer.on('cursor-changed',        (e,d)=>cb(d)),
  permissionResponse:  d  => ipcRenderer.send('permission-response', d),
  onDialog:            cb => ipcRenderer.on('page-dialog-show',      (e,d)=>cb(d)),
  dialogResponse:      d  => ipcRenderer.send('dialog-response',     d),
});