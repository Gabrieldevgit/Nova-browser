/* ═══════════════════════════════════════════════════════════
   Nova Browser — renderer.js
   Handles all UI logic and communicates with main via bridge
═══════════════════════════════════════════════════════════ */

// Global error handler — shows a visible red error instead of black screen
window.addEventListener('error', e => {
  document.body.innerHTML = `
    <div style="padding:40px;font-family:monospace;color:#ef4444;background:#0a0b0f;height:100vh;box-sizing:border-box;">
      <h2 style="margin-bottom:16px;">⚠️ Nova Renderer Error</h2>
      <pre style="background:#1a1a2e;padding:20px;border-radius:8px;white-space:pre-wrap;overflow:auto;">${e.message}\n\nFile: ${e.filename}\nLine: ${e.lineno}</pre>
      <p style="margin-top:16px;opacity:0.5;">Open DevTools (Ctrl+Shift+I) for full details.</p>
    </div>`;
});
window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled promise rejection:', e.reason);
});

// Hide the startup splash and check that the IPC bridge loaded
(function checkBridge() {
  const splash = document.getElementById('startup-check');
  if (!window.novaBridge) {
    if (splash) {
      splash.innerHTML = `
        <div style="font-size:36px;">⚠️</div>
        <div style="font-weight:600;color:#ef4444;">Preload bridge not found!</div>
        <div style="font-size:12px;opacity:0.6;max-width:400px;text-align:center;">
          preload.js failed to inject <code>window.novaBridge</code>.<br>
          Check that preload.js exists next to main.js and that the path in BrowserWindow is correct.
        </div>`;
    }
    throw new Error('window.novaBridge is undefined — preload.js did not load correctly');
  }
  // Bridge OK — hide splash
  if (splash) splash.style.display = 'none';
})();

// ── DATA ────────────────────────────────────────────────────
const BOOKMARKS = [
  { icon: '▶️', label: 'YouTube', url: 'https://www.youtube.com' },
  { icon: '🐙', label: 'GitHub',  url: 'https://github.com'      },
  { icon: '📘', label: 'Docs',    url: 'https://docs.google.com'  },
  { icon: '🤖', label: 'ChatGPT', url: 'https://chatgpt.com'      },
  { icon: '🌊', label: 'Figma',   url: 'https://figma.com'        },
  { icon: '📦', label: 'npm',     url: 'https://npmjs.com'        },
];

const NEWS = [
  { tag: 'TECH',    title: 'AI models are reshaping the browser experience in 2026', time: '2h ago' },
  { tag: 'PRIVACY', title: 'New EU regulation targets cross-site tracking',           time: '4h ago' },
  { tag: 'DEV',     title: 'WebAssembly 3.0 specification reaches candidate stage',  time: '6h ago' },
  { tag: 'SCIENCE', title: 'Quantum computing milestone: 1000-qubit stable processor',time:'8h ago' },
];

const SEARCH_URLS = {
  Google:     q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  DuckDuckGo: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  Bing:       q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

// ── STATE ───────────────────────────────────────────────────
let tabs         = [];
let activeTabId  = null;
let nextTabId    = 1;
let searchEngine = 'Google';
let sidebarOpen  = false;
let privacyOpen  = false;
let settingsOpen = false;

// ── HELPERS ─────────────────────────────────────────────────
const bridge = window.novaBridge;

function getTab(id)    { return tabs.find(t => t.id === id); }
function activeTab()   { return getTab(activeTabId); }
function isNewTab(tab) { return !tab || tab.url === 'nova://newtab'; }

function normalizeURL(raw) {
  raw = raw.trim();
  if (!raw) return null;
  // Already a full URL?
  if (/^https?:\/\//i.test(raw)) return raw;
  // Looks like a domain? (contains a dot, no spaces)
  if (/^[\w-]+\.[\w-]+/.test(raw) && !raw.includes(' ')) return 'https://' + raw;
  // Treat as a search query
  return SEARCH_URLS[searchEngine](raw);
}

function setAccent(color, rgb) {
  // rgb = "129,140,248" format
  const r = rgb || '129,140,248';
  const root = document.documentElement;
  root.style.setProperty('--accent',    color);
  root.style.setProperty('--accent-10', `rgba(${r},0.10)`);
  root.style.setProperty('--accent-12', `rgba(${r},0.12)`);
  root.style.setProperty('--accent-14', `rgba(${r},0.14)`);
  root.style.setProperty('--accent-18', `rgba(${r},0.18)`);
  root.style.setProperty('--accent-22', `rgba(${r},0.22)`);
  root.style.setProperty('--accent-35', `rgba(${r},0.35)`);
  root.style.setProperty('--accent-45', `rgba(${r},0.45)`);
  root.style.setProperty('--accent-55', `rgba(${r},0.55)`);
}

// ── TAB MANAGEMENT ──────────────────────────────────────────
function createTab(url = 'nova://newtab') {
  const id = nextTabId++;
  const tab = {
    id,
    url,
    title: url === 'nova://newtab' ? 'New Tab' : url,
    favicon: url === 'nova://newtab' ? '🌐' : null,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  tabs.push(tab);

  if (!isNewTab(tab)) {
    bridge.tabCreated({ tabId: id, url });
  }

  selectTab(id);
  return tab;
}

function closeTab(id) {
  if (tabs.length === 1) return; // keep at least one tab
  const idx = tabs.findIndex(t => t.id === id);
  bridge.tabClosed({ tabId: id });
  tabs.splice(idx, 1);

  if (activeTabId === id) {
    // Select neighbouring tab
    const newIdx = Math.min(idx, tabs.length - 1);
    selectTab(tabs[newIdx].id);
  } else {
    renderTabs();
  }
}

function selectTab(id) {
  activeTabId = id;
  const tab = activeTab();

  bridge.tabSelected({ tabId: id, url: tab.url });

  // Update nav buttons
  document.getElementById('back-btn').disabled    = !tab.canGoBack;
  document.getElementById('forward-btn').disabled = !tab.canGoForward;

  // Update omnibar
  const urlInput = document.getElementById('url-input');
  urlInput.value = isNewTab(tab) ? '' : tab.url;
  urlInput.placeholder = isNewTab(tab)
    ? `Search with ${searchEngine} or enter URL...`
    : tab.url;

  // Show/hide new tab page
  const ntPage = document.getElementById('newtab');
  const placeholder = document.getElementById('page-placeholder');

  if (isNewTab(tab)) {
    ntPage.classList.remove('hidden');
    placeholder.classList.remove('show');
  } else {
    ntPage.classList.add('hidden');
    placeholder.classList.add('show');
    document.getElementById('ph-favicon').textContent = tab.favicon || '🌐';
    document.getElementById('ph-title').textContent   = tab.title;
    document.getElementById('ph-url').textContent     = tab.url;
  }

  // Status bar
  document.getElementById('status-url').textContent = tab.url;

  renderTabs();
  closeAllPanels();
}

function navigateTo(url) {
  const tab = activeTab();
  if (!tab) return;

  if (isNewTab(tab)) {
    // Move this tab from newtab to a real page
    tab.url   = url;
    tab.title = url;
    tab.favicon = null;
    bridge.tabCreated({ tabId: tab.id, url });
    bridge.tabSelected({ tabId: tab.id, url });
    document.getElementById('newtab').classList.add('hidden');
    document.getElementById('page-placeholder').classList.add('show');
  } else {
    tab.url = url;
    bridge.navigate({ tabId: tab.id, url });
  }

  document.getElementById('url-input').value = url;
  document.getElementById('status-url').textContent = url;
  renderTabs();
}

// ── RENDER TABS ─────────────────────────────────────────────
function renderTabs() {
  const container = document.getElementById('tabs-container');
  container.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');

    // Favicon
    const faviconEl = document.createElement('span');
    faviconEl.className = 'tab-favicon';
    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      faviconEl.appendChild(spinner);
    } else if (tab.faviconUrl) {
      const img = document.createElement('img');
      img.src = tab.faviconUrl;
      img.onerror = () => { img.style.display = 'none'; };
      faviconEl.appendChild(img);
    } else {
      faviconEl.textContent = tab.favicon || '🌐';
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || tab.url || 'New Tab';

    const closeEl = document.createElement('button');
    closeEl.className = 'tab-close';
    closeEl.textContent = '✕';
    closeEl.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(faviconEl);
    el.appendChild(titleEl);
    el.appendChild(closeEl);
    el.addEventListener('click', () => selectTab(tab.id));

    container.appendChild(el);
  });

  // Status bar tab count
  const idx = tabs.findIndex(t => t.id === activeTabId);
  document.getElementById('status-right').textContent =
    `Tab ${idx + 1} of ${tabs.length} · Nova Browser v0.2.0`;
}

// ── PANELS ──────────────────────────────────────────────────
function closeAllPanels() {
  document.getElementById('privacy-panel').classList.remove('show');
  document.getElementById('settings-panel').classList.remove('show');
  document.getElementById('privacy-btn').classList.remove('active');
  document.getElementById('settings-btn').classList.remove('active');
  privacyOpen  = false;
  settingsOpen = false;
}

function togglePrivacy() {
  const was = privacyOpen;
  closeAllPanels();
  if (!was) {
    document.getElementById('privacy-panel').classList.add('show');
    document.getElementById('privacy-btn').classList.add('active');
    privacyOpen = true;
    animateBars();
  }
}

function toggleSettings() {
  const was = settingsOpen;
  closeAllPanels();
  if (!was) {
    document.getElementById('settings-panel').classList.add('show');
    document.getElementById('settings-btn').classList.add('active');
    settingsOpen = true;
  }
}

function animateBars() {
  setTimeout(() => {
    document.getElementById('bar-trackers').style.width = `${(1284/1500)*100}%`;
    document.getElementById('bar-cookies').style.width  = `${(472/700)*100}%`;
    document.getElementById('bar-fp').style.width       = `${(38/80)*100}%`;
  }, 80);
}

// ── BUILD NEW-TAB PAGE ───────────────────────────────────────
function buildNewTabPage() {
  // Date
  document.getElementById('nt-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // Bookmarks
  const grid = document.getElementById('bk-grid');
  BOOKMARKS.forEach(b => {
    const card = document.createElement('div');
    card.className = 'bk-card';
    card.innerHTML = `<span class="bk-icon">${b.icon}</span><span class="bk-label">${b.label}</span>`;
    card.addEventListener('click', () => navigateTo(b.url));
    grid.appendChild(card);
  });

  // News
  const list = document.getElementById('news-list');
  NEWS.forEach(n => {
    const item = document.createElement('div');
    item.className = 'news-item';
    item.innerHTML = `
      <span class="news-tag">${n.tag}</span>
      <span class="news-title">${n.title}</span>
      <span class="news-time">${n.time}</span>
    `;
    list.appendChild(item);
  });
}

// ── SUGGESTIONS ─────────────────────────────────────────────
const STATIC_SUGGESTIONS = [
  { icon: '⭐', text: 'YouTube',       url: 'https://youtube.com'  },
  { icon: '⭐', text: 'GitHub',        url: 'https://github.com'   },
  { icon: '⭐', text: 'Google',        url: 'https://google.com'   },
  { icon: '⭐', text: 'ChatGPT',       url: 'https://chatgpt.com'  },
];

function buildSuggestions(query) {
  const box = document.getElementById('suggestions');
  box.innerHTML = '';
  const q = query.toLowerCase().trim();

  let rows = [];
  if (!q) {
    rows = STATIC_SUGGESTIONS.map(s => ({ icon: s.icon, text: s.text, url: s.url }));
  } else {
    // Filter bookmarks
    const matched = STATIC_SUGGESTIONS.filter(s => s.text.toLowerCase().includes(q));
    rows = matched.map(s => ({ icon: '⭐', text: s.text, url: s.url }));
    // Search suggestion
    rows.push({ icon: '🔍', text: `Search: "${query}"`, url: SEARCH_URLS[searchEngine](query) });
    // URL suggestion if looks like domain
    if (/^[\w-]+\./.test(q)) rows.push({ icon: '🌐', text: q, url: 'https://' + q });
  }

  rows.slice(0, 5).forEach(r => {
    const el = document.createElement('div');
    el.className = 'sug-row';
    el.innerHTML = `<span class="sug-icon">${r.icon}</span><span class="sug-text">${r.text}</span><span class="sug-arrow">↗</span>`;
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      document.getElementById('url-input').value = r.url;
      document.getElementById('suggestions').classList.remove('show');
      navigateTo(r.url);
    });
    box.appendChild(el);
  });

  box.classList.toggle('show', rows.length > 0);
}

// ── WIRE UP EVENTS ───────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  buildNewTabPage();

  // ── Initial tab ──
  createTab('nova://newtab');

  // ── New tab button ──
  document.getElementById('new-tab-btn').addEventListener('click', () => createTab());

  // ── Sidebar ──
  document.getElementById('sidebar-btn').addEventListener('click', e => {
    e.stopPropagation();
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
  });

  document.querySelectorAll('.ws-row').forEach(row => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.ws-row').forEach(r => r.classList.remove('on'));
      row.classList.add('on');
    });
  });

  // ── Nav buttons ──
  document.getElementById('back-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (tab) bridge.goBack({ tabId: tab.id });
  });
  document.getElementById('forward-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (tab) bridge.goForward({ tabId: tab.id });
  });
  document.getElementById('reload-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (tab && !isNewTab(tab)) bridge.reload({ tabId: tab.id });
  });

  // ── Window controls ──
  document.getElementById('win-min').addEventListener('click',   () => bridge.winMinimize());
  document.getElementById('win-max').addEventListener('click',   () => bridge.winMaximize());
  document.getElementById('win-close').addEventListener('click', () => bridge.winClose());

  // ── OmniBar ──
  const urlInput = document.getElementById('url-input');
  const sugBox   = document.getElementById('suggestions');
  const clearBtn = document.getElementById('url-clear-btn');
  const omniBox  = document.getElementById('omnibar-box');

  urlInput.addEventListener('focus', () => {
    omniBox.classList.add('focused');
    urlInput.select();
    buildSuggestions(urlInput.value);
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => {
      omniBox.classList.remove('focused');
      sugBox.classList.remove('show');
    }, 160);
  });
  urlInput.addEventListener('input', () => {
    clearBtn.style.display = urlInput.value ? 'block' : 'none';
    buildSuggestions(urlInput.value);
  });
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = normalizeURL(urlInput.value);
      if (url) {
        sugBox.classList.remove('show');
        navigateTo(url);
        urlInput.blur();
      }
    }
    if (e.key === 'Escape') {
      urlInput.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    urlInput.focus();
    buildSuggestions('');
  });

  // ── New-tab page big search ──
  const ntInput = document.getElementById('nt-input');
  ntInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const url = normalizeURL(ntInput.value);
      if (url) {
        ntInput.value = '';
        navigateTo(url);
      }
    }
  });

  // ── Privacy panel ──
  document.getElementById('privacy-btn').addEventListener('click', e => {
    e.stopPropagation();
    togglePrivacy();
  });

  // ── Settings panel ──
  document.getElementById('settings-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleSettings();
  });

  // Theme buttons
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.body.className = btn.dataset.theme === 'light' ? 'light' : '';
      document.querySelectorAll('[data-theme]').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
    });
  });

  // Accent color
  document.querySelectorAll('.c-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.c-dot').forEach(d => d.classList.remove('on'));
      dot.classList.add('on');
      setAccent(dot.dataset.color, dot.dataset.rgb);
    });
  });

  // Search engine
  document.querySelectorAll('[data-engine]').forEach(btn => {
    btn.addEventListener('click', () => {
      searchEngine = btn.dataset.engine;
      document.querySelectorAll('[data-engine]').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('nt-input').placeholder =
        `Search with ${searchEngine} or enter a URL...`;
      if (isNewTab(activeTab())) {
        urlInput.placeholder = `Search with ${searchEngine} or enter URL...`;
      }
    });
  });

  // Close panels on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.panel') && !e.target.closest('#privacy-btn') && !e.target.closest('#settings-btn')) {
      closeAllPanels();
    }
  });

  // ── IPC from main process ──
  bridge.onTabNavigated(({ tabId, url, title }) => {
    const tab = getTab(tabId);
    if (!tab) return;
    tab.url   = url;
    tab.title = title || url;
    if (tabId === activeTabId) {
      urlInput.value = url;
      document.getElementById('status-url').textContent = url;
      document.getElementById('ph-url').textContent   = url;
      document.getElementById('ph-title').textContent = tab.title;
      // Update nav buttons (we'll derive from loading state)
    }
    renderTabs();
  });

  bridge.onTabTitleUpdated(({ tabId, title }) => {
    const tab = getTab(tabId);
    if (tab) { tab.title = title; renderTabs(); }
    if (tabId === activeTabId) document.getElementById('ph-title').textContent = title;
  });

  bridge.onTabFavicon(({ tabId, favicon }) => {
    const tab = getTab(tabId);
    if (tab) { tab.faviconUrl = favicon; renderTabs(); }
  });

  bridge.onTabLoading(({ tabId, loading }) => {
    const tab = getTab(tabId);
    if (tab) {
      tab.loading = loading;
      if (tabId === activeTabId) {
        document.getElementById('reload-btn').textContent = loading ? '✕' : '⟳';
        document.getElementById('reload-btn').title = loading ? 'Stop' : 'Reload';
        if (loading) {
          document.getElementById('reload-btn').onclick = () => bridge.reload({ tabId });
        }
      }
      renderTabs();
    }
  });

  bridge.onInit(({ date }) => {
    document.getElementById('nt-date').textContent = date;
  });
});