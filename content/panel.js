/* ============================================================
   scAI — in-page docked panel host

   Firefox's sidebar_action always lives in the browser's own
   sidebar rail (left by default, and it lights up the sidebar
   switcher). To dock scAI on the right without touching that
   rail, this content script injects sidebar/sidebar.html into a
   fixed-position iframe pinned to the right edge of the page.

   Everything privileged still happens in the background page;
   the iframe is a normal moz-extension: document, so the sidebar
   code inside it keeps its storage + host permissions.

   Kept deliberately defensive: this runs on every page, so it
   must not throw, must not leak globals, and must survive being
   injected twice.
   ============================================================ */
'use strict';

(function () {
  // executeScript may land here twice on the same document.
  if (window.__scaiPanelHost) return;
  window.__scaiPanelHost = true;

  const B = typeof browser !== 'undefined' ? browser : chrome;

  const HOST_ID = 'scai-panel-host';
  const MIN_W = 300;
  const MAX_W = 900;
  const DEFAULT_W = 420;

  let host = null;      // outer positioned container
  let frame = null;     // the extension iframe
  let grip = null;      // resize handle
  let open = false;
  let width = DEFAULT_W;

  /* ---------------- build ---------------- */

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('role', 'complementary');
    host.setAttribute('aria-label', 'scAI');

    // All-longhand and !important so page CSS can't reach in and
    // restyle us. z-index sits just under 2^31 to win over most
    // sticky headers and cookie banners.
    host.style.cssText = [
      'position: fixed !important',
      'top: 0 !important',
      'right: 0 !important',
      'bottom: 0 !important',
      'left: auto !important',
      'width: ' + width + 'px !important',
      'height: 100% !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: 0 !important',
      'z-index: 2147483000 !important',
      'display: block !important',
      'visibility: visible !important',
      'opacity: 1 !important',
      'transform: none !important',
      'pointer-events: auto !important',
      'box-shadow: -1px 0 0 rgba(0,0,0,0.10), -12px 0 32px rgba(0,0,0,0.10) !important',
      'background: #f4f1ea !important',
      'color-scheme: normal !important'
    ].join(';');

    frame = document.createElement('iframe');
    frame.src = B.runtime.getURL('sidebar/sidebar.html?embedded=1');
    frame.title = 'scAI';
    frame.setAttribute('allowtransparency', 'false');
    frame.style.cssText = [
      'position: absolute !important',
      'inset: 0 !important',
      'width: 100% !important',
      'height: 100% !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: 0 !important',
      'display: block !important',
      'background: #f4f1ea !important',
      'color-scheme: normal !important'
    ].join(';');

    grip = document.createElement('div');
    grip.setAttribute('aria-hidden', 'true');
    grip.style.cssText = [
      'position: absolute !important',
      'top: 0 !important',
      'left: -3px !important',
      'width: 7px !important',
      'height: 100% !important',
      'cursor: ew-resize !important',
      'z-index: 2 !important',
      'background: transparent !important'
    ].join(';');
    grip.addEventListener('mousedown', startResize);

    host.appendChild(grip);
    host.appendChild(frame);
    (document.body || document.documentElement).appendChild(host);
  }

  /* ---------------- resize ---------------- */

  function startResize(e) {
    e.preventDefault();
    // Pointer events must stop reaching the iframe or the drag
    // dies the moment the cursor crosses into it.
    frame.style.setProperty('pointer-events', 'none', 'important');
    const move = (ev) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      width = w;
      host.style.setProperty('width', w + 'px', 'important');
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      frame.style.setProperty('pointer-events', 'auto', 'important');
      saveWidth(width);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  async function saveWidth(w) {
    try {
      const raw = await B.storage.local.get('settings');
      const settings = Object.assign({}, raw.settings || {}, { panelWidth: w });
      await B.storage.local.set({ settings });
    } catch (e) { /* storage is best-effort here */ }
  }

  async function loadWidth() {
    try {
      const raw = await B.storage.local.get('settings');
      const w = raw && raw.settings && raw.settings.panelWidth;
      if (typeof w === 'number' && w >= MIN_W && w <= MAX_W) width = w;
    } catch (e) { /* keep the default */ }
  }

  /* ---------------- open / close ---------------- */

  function show() {
    build();
    host.style.setProperty('display', 'block', 'important');
    open = true;
    // Focus the composer without yanking the page's scroll position.
    try { frame.contentWindow.focus(); } catch (e) { /* cross-doc timing */ }
  }

  function hide() {
    if (!host) return;
    host.style.setProperty('display', 'none', 'important');
    open = false;
  }

  function toggle() {
    if (open) hide(); else show();
  }

  /* ---------------- wiring ---------------- */

  // The sidebar document asks its host to close; it can't reach
  // into the page directly, so it posts up.
  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'scai:closePanel') hide();
  });

  B.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'scai:panelToggle':
        toggle();
        return Promise.resolve({ ok: true, open });
      case 'scai:panelOpen':
        show();
        return Promise.resolve({ ok: true, open });
      case 'scai:panelClose':
        hide();
        return Promise.resolve({ ok: true, open });
      case 'scai:panelPing':
        return Promise.resolve({ ok: true, open });
      default:
        return;
    }
  });

  loadWidth();
})();
