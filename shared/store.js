/* ============================================================
   scAI — storage layer (browser.storage.local)

   Keys
     settings    – generation + page-access preferences
     providers   – user edits/additions layered over the presets
     keys        – { [providerId]: apiKey }
     chats       – [{ id, title, createdAt, updatedAt, messages }]
     activeChat  – id of the chat shown in the sidebar
   ============================================================ */
(function (root) {
  'use strict';

  const B = root.browser || root.chrome;
  const area = B.storage.local;

  const DEFAULT_SYSTEM_PROMPT =
    'You are scAI, a concise, level-headed assistant living in the user\'s browser sidebar. ' +
    'Answer directly and skip filler. Use short markdown — headings only when they help, ' +
    'fenced code blocks for code. When page context is provided, ground your answer in it and ' +
    'say so plainly if the page does not actually contain the answer.';

  const DEFAULTS = {
    settings: {
      providerId: 'anthropic',
      model: 'claude-opus-5',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxTokens: 32000,
      temperature: 1,
      sendTemperature: false,
      thinking: 'off',        // 'off' | 'adaptive'
      showThinking: true,
      effort: '',             // '' = provider default
      usePage: false,         // "let scAI see this page"
      useSelection: true,     // prefer highlighted text when there is some
      fullPage: false,        // send the whole document, not just the article
      contextChars: 12000,
      showUsage: true,
      historyTurns: 20,       // how many prior messages to resend
      dock: 'page',           // 'page' = right-docked in-page panel
                              // 'sidebar' = Firefox's own sidebar rail
      panelWidth: 420         // width of the in-page panel, px
    },
    providers: [],
    keys: {},
    chats: [],
    activeChat: null
  };

  function deep(target, src) {
    const out = Array.isArray(src) ? src.slice() : Object.assign({}, target);
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const k of Object.keys(src)) {
        out[k] = (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]))
          ? deep(target[k] || {}, src[k])
          : src[k];
      }
    }
    return out;
  }

  async function getAll() {
    const raw = await area.get(Object.keys(DEFAULTS));
    return {
      settings: Object.assign({}, DEFAULTS.settings, raw.settings || {}),
      providers: raw.providers || [],
      keys: raw.keys || {},
      chats: Array.isArray(raw.chats) ? raw.chats : [],
      activeChat: raw.activeChat || null
    };
  }

  async function get(key) {
    const raw = await area.get(key);
    if (key === 'settings') return Object.assign({}, DEFAULTS.settings, raw.settings || {});
    return raw[key] === undefined ? DEFAULTS[key] : raw[key];
  }

  async function set(patch) {
    return area.set(patch);
  }

  async function patchSettings(patch) {
    const settings = await get('settings');
    const next = Object.assign({}, settings, patch);
    await set({ settings: next });
    return next;
  }

  async function getKey(providerId) {
    const keys = await get('keys');
    return (keys && keys[providerId]) || '';
  }

  async function setKey(providerId, value) {
    const keys = await get('keys');
    if (value) keys[providerId] = value;
    else delete keys[providerId];
    await set({ keys });
    return keys;
  }

  /* ---------------- chats ---------------- */

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function newChat() {
    const now = Date.now();
    return { id: uid(), title: '', createdAt: now, updatedAt: now, messages: [] };
  }

  async function saveChat(chat) {
    const chats = await get('chats');
    chat.updatedAt = Date.now();
    const i = chats.findIndex(c => c.id === chat.id);
    if (i >= 0) chats[i] = chat; else chats.unshift(chat);
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    // Keep the store bounded; images make chats heavy.
    await set({ chats: chats.slice(0, 100), activeChat: chat.id });
    return chat;
  }

  async function deleteChat(id) {
    const chats = (await get('chats')).filter(c => c.id !== id);
    const active = await get('activeChat');
    await set({ chats, activeChat: active === id ? (chats[0] ? chats[0].id : null) : active });
    return chats;
  }

  async function clearChats() {
    await set({ chats: [], activeChat: null });
  }

  function titleFor(chat) {
    if (chat.title) return chat.title;
    const first = (chat.messages || []).find(m => m.role === 'user');
    const text = first ? String(first.content || '').replace(/\s+/g, ' ').trim() : '';
    if (!text) return 'New chat';
    return text.length > 52 ? text.slice(0, 52).trimEnd() + '…' : text;
  }

  root.scaiStore = {
    DEFAULTS, DEFAULT_SYSTEM_PROMPT, getAll, get, set, patchSettings,
    getKey, setKey, uid, newChat, saveChat, deleteChat, clearChats, titleFor, deep
  };
})(typeof window !== 'undefined' ? window : self);
