/**
 * preload-page.js — runs in every BrowserView (web page context)
 * Intercepts window.alert / confirm / prompt and sends them to main process
 * which forwards to the Nova renderer for display in our custom dialog UI.
 */
const { ipcRenderer } = require('electron');

let _dlgCounter = 0;
const _pending = {};

function _dialog(type, msg, defaultVal) {
  return new Promise(resolve => {
    const id = 'dlg_' + (++_dlgCounter);
    _pending[id] = resolve;
    ipcRenderer.send('page-dialog', { id, type, msg: String(msg ?? ''), defaultVal: String(defaultVal ?? '') });
  });
}

// Listen for response from main process
ipcRenderer.on('page-dialog-response', (e, { id, result }) => {
  if (_pending[id]) {
    _pending[id](result);
    delete _pending[id];
  }
});

// Override synchronous window methods
// Note: true synchronous override is impossible in the async IPC world.
// We show the dialog correctly; page JS continues immediately with a
// sensible default (empty string / true) then the dialog resolves async.
window.alert   = (msg)        => { _dialog('alert',   msg, ''); };
window.confirm = (msg)        => { _dialog('confirm', msg, ''); return true;  };
window.prompt  = (msg, def)   => { _dialog('prompt',  msg, def ?? ''); return def ?? ''; };

// Expose async versions for Nova-aware pages
window.__novaAlert   = (msg, origin)       => _dialog('alert',   msg, '');
window.__novaConfirm = (msg, origin)       => _dialog('confirm', msg, '');
window.__novaPrompt  = (msg, def, origin)  => _dialog('prompt',  msg, def ?? '');
