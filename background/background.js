/* ============================================================
   scAI — background (event page)

   Owns the privileged bits the sidebar can't do itself:
     • toolbar click / context menu → toggle or open the panel
     • readPage    → inject content/extract.js into the active tab
     • screenshot  → tabs.captureVisibleTab of the active tab
     • pendingPrompt handoff for the context-menu action

   Two docking modes, chosen in settings (`dock`):
     'page'    – default. Injects content/panel.js, which hosts
                 sidebar.html in a right-docked iframe. Keeps out
                 of Firefox's sidebar rail entirely.
     'sidebar' – the classic sidebarAction, left rail.
   Pages where content scripts can't run (about:, PDF viewer)
   fall back to the sidebar automatically.

   The API calls themselves happen in the sidebar, which has host
   permissions of its own — keeping the stream in the UI context
   avoids proxying every token through a message port.
   ============================================================ */
'use strict';

const B = typeof browser !== 'undefined' ? browser : chrome;

const MENU_ASK = 'scai-ask-selection';
const MENU_PAGE = 'scai-ask-page';

let pendingPrompt = null;

/* ---------------- dock plumbing ---------------- */

/* Firefox only allows sidebarAction.open() from inside a user-input
   handler, and any `await` before it forfeits that context. So both
   the dock preference and the active tab's URL are mirrored here,
   kept fresh by events, letting the toolbar handler decide and act
   synchronously. */
let dockCached = 'page';
let activeUrl = '';
let activeId = null;

async function primeCaches() {
  dockCached = await readDock();
  try {
    const tab = await activeTab();
    if (tab) { activeUrl = tab.url || ''; activeId = tab.id; }
  } catch (e) { /* nothing to mirror yet */ }
}

async function readDock() {
  try {
    const raw = await B.storage.local.get('settings');
    return (raw && raw.settings && raw.settings.dock) === 'sidebar' ? 'sidebar' : 'page';
  } catch (e) {
    return 'page';
  }
}

primeCaches();

B.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue;
  dockCached = (next && next.dock) === 'sidebar' ? 'sidebar' : 'page';
});

async function noteTab(tabId) {
  try {
    const tab = await B.tabs.get(tabId);
    if (tab && tab.active) { activeUrl = tab.url || ''; activeId = tab.id; }
  } catch (e) { /* tab vanished */ }
  // Sidebar documents can't all subscribe to browser.tabs themselves,
  // so tell them the active tab moved.
  B.runtime.sendMessage({ type: 'scai:tabChanged' }).catch(() => {});
}

B.tabs.onActivated.addListener((info) => noteTab(info.tabId));
B.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined) noteTab(tabId);
  else if (change.status === 'complete' || change.title !== undefined) {
    B.runtime.sendMessage({ type: 'scai:tabChanged' }).catch(() => {});
  }
});

function dockMode() {
  return dockCached;
}

/* Set when right-docked mode was asked for but the page couldn't host
   the iframe, so we opened Firefox's rail instead. The sidebar picks
   this up on boot (it may not exist yet when we fall back) and shows a
   dismissible line rather than silently appearing on the wrong side. */
let dockNotice = null;

const RAIL_FALLBACK_NOTE =
  'This page can\'t host the docked panel, so scAI opened in Firefox\'s sidebar. ' +
  'Your "docked right" setting still applies on normal pages.';

function noteRailFallback() {
  dockNotice = RAIL_FALLBACK_NOTE;
  // If a sidebar document is already alive, tell it now; the boot-time
  // fetch covers the case where it isn't.
  B.runtime.sendMessage({ type: 'scai:dockNotice', text: dockNotice }).catch(() => {});
}

/* Ensure content/panel.js is live in the tab, then talk to it.
   Returns false when the tab can't host a content script. */
async function reachPanel(tab, type) {
  if (!tab || unreadable(tab.url)) return false;
  try {
    return !!(await B.tabs.sendMessage(tab.id, { type }));
  } catch (e) {
    // Not injected yet (fresh tab, or extension just reloaded).
    try {
      await B.tabs.executeScript(tab.id, { file: '/content/panel.js' });
      return !!(await B.tabs.sendMessage(tab.id, { type }));
    } catch (err) {
      return false;
    }
  }
}

/* Must stay synchronous down to any sidebarAction call. */
function showPanel(toggle) {
  if (dockCached === 'sidebar') {
    dockNotice = null;
    if (toggle) B.sidebarAction.toggle();
    else B.sidebarAction.open();
    return;
  }
  // Browser-internal pages and the PDF viewer can't host the iframe.
  // Decide from the mirrored URL so the gesture is still live. An
  // empty mirror means "not primed yet", which is not the same as
  // unreadable — fall through to the async path rather than
  // wrongly opening the rail.
  if (activeUrl && unreadable(activeUrl)) {
    if (toggle) B.sidebarAction.toggle();
    else B.sidebarAction.open();
    noteRailFallback();
    return;
  }
  // executeScript/sendMessage need no gesture, so async is fine here.
  (async () => {
    const tab = await activeTab();
    if (tab) { activeUrl = tab.url || ''; activeId = tab.id; }
    const ok = await reachPanel(tab, toggle ? 'scai:panelToggle' : 'scai:panelOpen');
    if (ok) {
      dockNotice = null;
      return;
    }
    // The mirror was stale. Can't open the rail without a gesture,
    // so say so on the button rather than failing silently.
    B.browserAction.setBadgeText({ text: '!' });
    B.browserAction.setTitle({
      title: 'scAI can\'t run on this page — press Alt+Shift+A again or open a normal tab'
    });
    setTimeout(() => {
      B.browserAction.setBadgeText({ text: '' });
      B.browserAction.setTitle({ title: 'Toggle scAI (Alt+Shift+A)' });
    }, 4000);
  })();
}

/* ---------------- toolbar + menus ---------------- */

B.browserAction.onClicked.addListener(() => { showPanel(true); });

B.runtime.onInstalled.addListener(() => {
  B.contextMenus.removeAll(() => {
    B.contextMenus.create({
      id: MENU_ASK,
      title: 'Ask scAI about "%s"',
      contexts: ['selection']
    });
    B.contextMenus.create({
      id: MENU_PAGE,
      title: 'Ask scAI about this page',
      contexts: ['page']
    });
  });
});

B.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ASK) {
    const text = (info.selectionText || '').trim();
    pendingPrompt = { kind: 'selection', text, at: Date.now() };
  } else if (info.menuItemId === MENU_PAGE) {
    pendingPrompt = { kind: 'page', text: '', at: Date.now() };
  } else {
    return;
  }
  // The menu click is itself the gesture; keep it synchronous. The
  // tab comes in as an argument, so no lookup is needed.
  if (tab && tab.url) { activeUrl = tab.url; activeId = tab.id; }
  showPanel(false);
  // The panel may already be open and idle, so nudge it too.
  B.runtime.sendMessage({ type: 'scai:pending' }).catch(() => {});
});

/* ---------------- helpers ---------------- */

async function activeTab() {
  const tabs = await B.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function unreadable(url) {
  return !url || /^(about:|moz-extension:|chrome:|resource:|view-source:|file:)/i.test(url);
}

async function readPage() {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: 'No active tab.' };
  if (unreadable(tab.url)) {
    return {
      ok: false,
      error: 'scAI can\'t read this page (' + (tab.url || 'unknown') + '). Browser-internal and ' +
             'local-file pages are off limits to extensions.',
      url: tab.url || '',
      title: tab.title || ''
    };
  }
  try {
    const results = await B.tabs.executeScript(tab.id, { file: '/content/extract.js' });
    const data = results && results[0];
    if (!data || !data.ok) throw new Error('The page returned no readable content.');
    return data;
  } catch (err) {
    return {
      ok: false,
      error: 'Could not read the page: ' + (err && err.message ? err.message : String(err)),
      url: tab.url || '',
      title: tab.title || ''
    };
  }
}

async function screenshot() {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: 'No active tab.' };
  if (unreadable(tab.url)) {
    return { ok: false, error: 'scAI can\'t capture browser-internal pages.' };
  }
  try {
    const dataUrl = await B.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl, title: tab.title || '', url: tab.url || '' };
  } catch (err) {
    return { ok: false, error: 'Screenshot failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

async function tabInfo() {
  const tab = await activeTab();
  if (!tab) return { ok: false };
  return {
    ok: !unreadable(tab.url),
    title: tab.title || '',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || ''
  };
}

/* ---------------- message router ---------------- */

B.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'scai:readPage':
      return readPage();
    case 'scai:screenshot':
      return screenshot();
    case 'scai:tabInfo':
      return tabInfo();
    case 'scai:takePending': {
      const p = pendingPrompt;
      pendingPrompt = null;
      return Promise.resolve(p);
    }
    case 'scai:openOptions':
      B.runtime.openOptionsPage();
      return Promise.resolve({ ok: true });
    case 'scai:closeSelf':
      // The embedded panel closes itself via its host; the rail
      // sidebar has to be closed through the API.
      if (dockMode() === 'sidebar') B.sidebarAction.close();
      return Promise.resolve({ ok: true });

    /* A sidebar-rail document just booted. Firefox restores its own
       sidebar across restarts and the sidebar switcher can open us
       directly, both of which bypass showPanel() entirely — that is
       how scAI ends up on the left despite a 'page' dock preference.
       Put it back where the user asked for it, or explain why not. */
    case 'scai:railBooted':
      return (async () => {
        const mode = await readDock();
        dockCached = mode;
        if (mode === 'sidebar') return { ok: true, moved: false };
        const tab = await activeTab();
        if (tab) { activeUrl = tab.url || ''; activeId = tab.id; }
        const ok = await reachPanel(tab, 'scai:panelOpen');
        if (ok) {
          dockNotice = null;
          try { B.sidebarAction.close(); } catch (e) { /* already gone */ }
          return { ok: true, moved: true };
        }
        dockNotice = RAIL_FALLBACK_NOTE;
        return { ok: true, moved: false, notice: RAIL_FALLBACK_NOTE };
      })();

    case 'scai:takeDockNotice': {
      const n = dockNotice;
      dockNotice = null;
      return Promise.resolve({ notice: n });
    }
    case 'scai:dockChanged':
      // Tear down whichever surface is now stale so the switch
      // doesn't leave two copies of scAI on screen. Read storage
      // directly: storage.onChanged may not have updated the mirror
      // yet, since the sender writes and messages back to back.
      return (async () => {
        const mode = await readDock();
        dockCached = mode;
        const tab = await activeTab();
        if (mode === 'sidebar') {
          await reachPanel(tab, 'scai:panelClose');
          // No user gesture survives the message hop, so this may be
          // refused; the user can open the rail themselves.
          try { B.sidebarAction.open(); } catch (e) { /* needs a gesture */ }
        } else {
          try { B.sidebarAction.close(); } catch (e) { /* already shut */ }
          const ok = await reachPanel(tab, 'scai:panelOpen');
          if (!ok) noteRailFallback();
        }
        return { ok: true, dock: mode };
      })();
    default:
      return;
  }
});
