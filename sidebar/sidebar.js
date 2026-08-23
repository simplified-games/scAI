/* ============================================================
   scAI — sidebar controller

   Owns: provider/model selection, the transcript, the composer,
   page-context capture, image attachments, history, and settings.
   API calls stream in this context (see shared/api.js); the
   background page only does the privileged bits (tab read,
   screenshot, context menu).
   ============================================================ */
'use strict';

const B = typeof browser !== 'undefined' ? browser : chrome;
const { resolveProviders, findProvider, findModel } = window.scaiProviders;
const store = window.scaiStore;
const api = window.scaiApi;
const md = window.scaiMarkdown;

const $ = id => document.getElementById(id);

const el = {
  thread: $('thread'),
  empty: $('empty'),
  emptySub: $('empty-sub'),
  suggestions: $('suggestions'),
  provider: $('sel-provider'),
  model: $('sel-model'),
  keywarn: $('keywarn'),
  keywarnText: $('keywarn-text'),
  keywarnAction: $('keywarn-action'),
  notice: $('notice'),
  noticeText: $('notice-text'),
  noticeOff: $('notice-off'),
  prompt: $('prompt'),
  composer: $('composer'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  hint: $('composer-hint'),
  btnPage: $('btn-page'),
  btnShot: $('btn-shot'),
  btnImage: $('btn-image'),
  fileImage: $('file-image'),
  ctxStrip: $('context-strip'),
  ctxText: $('context-text'),
  ctxOff: $('context-off'),
  attachments: $('attachments'),
  dropVeil: $('drop-veil'),
  panelHistory: $('panel-history'),
  panelSettings: $('panel-settings'),
  historyList: $('history-list'),
  btnClose: $('btn-close')
};

/* True when we're running inside content/panel.js's iframe rather
   than Firefox's sidebar rail. The host adds ?embedded=1. */
const EMBEDDED = new URLSearchParams(location.search).get('embedded') === '1';

/* ---------------- state ---------------- */

const state = {
  settings: null,
  providers: [],
  keys: {},
  chat: null,
  provider: null,
  model: null,
  attachments: [],   // { id, mediaType, data, dataUrl, name, source }
  streaming: false,
  controller: null,
  tab: null
};

/* ---------------- small helpers ---------------- */

function toast(message) {
  const prev = document.querySelector('.toast');
  if (prev) prev.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/**
 * A persistent, dismissible line under the model strip. Used when
 * something about placement had to differ from what was asked for —
 * a toast would vanish before it explained itself.
 */
function showNotice(message) {
  if (!el.notice) return;
  el.noticeText.textContent = message;
  el.notice.hidden = false;
}

function icon(paths, extra) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', (extra && extra.width) || '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  redo: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  quote: ['M7 8h10', 'M7 12h10', 'M7 16h6'],
  camera: ['M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4z',
           'M15.5 12.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z'],
  spark: ['M12 3v4', 'M12 17v4', 'M5.6 5.6l2.8 2.8', 'M15.6 15.6l2.8 2.8', 'M3 12h4', 'M17 12h4']
};

function fmtInt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '';
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function autosize() {
  el.prompt.style.height = 'auto';
  el.prompt.style.height = Math.min(190, el.prompt.scrollHeight) + 'px';
}

function atBottom() {
  return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 90;
}

function scrollDown(force) {
  if (force || atBottom()) el.thread.scrollTop = el.thread.scrollHeight;
}

/**
 * Trim from the middle so both the top and the tail of a long page survive —
 * headers and conclusions are usually where the answer lives.
 */
function clampMiddle(text, limit) {
  if (!text || text.length <= limit) return text || '';
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return text.slice(0, head).trimEnd() +
    '\n\n…[' + fmtInt(text.length - limit) + ' characters trimmed]…\n\n' +
    text.slice(text.length - tail).trimStart();
}

function dataUrlToImage(dataUrl, name, source) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m || !m[2]) return null;
  return {
    id: store.uid(),
    mediaType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1],
    data: m[3],
    dataUrl,
    name: name || 'image',
    source: source || 'paste'
  };
}

function fileToImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(dataUrlToImage(String(reader.result), file.name, 'file'));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   Provider / model selection
   ============================================================ */

function currentKey() {
  return (state.keys && state.keys[state.settings.providerId]) || '';
}

function fillProviders() {
  el.provider.textContent = '';
  for (const p of state.providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    el.provider.appendChild(o);
  }
  el.provider.value = state.provider ? state.provider.id : '';
}

function fillModels() {
  el.model.textContent = '';
  const models = (state.provider && state.provider.models) || [];
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label || m.id;
    el.model.appendChild(o);
  }

  // A hand-typed model (or one added in the options page) still needs a row.
  const known = models.some(m => m.id === state.settings.model);
  if (state.settings.model && !known) {
    const o = document.createElement('option');
    o.value = state.settings.model;
    o.textContent = state.settings.model + ' (custom)';
    el.model.insertBefore(o, el.model.firstChild);
  }

  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Type a model ID…';
  el.model.appendChild(custom);

  el.model.value = state.settings.model || (models[0] && models[0].id) || '__custom__';
}

function resolveSelection() {
  state.provider = findProvider(state.providers, state.settings.providerId);
  if (state.provider && state.provider.id !== state.settings.providerId) {
    state.settings.providerId = state.provider.id;
  }
  state.model = findModel(state.provider, state.settings.model);
  if (!state.model && state.provider && state.provider.models[0]) {
    state.model = state.provider.models[0];
    state.settings.model = state.model.id;
  }
}

function updateKeyWarning() {
  const p = state.provider;
  if (!p) return;
  const needsKey = !p.noKeyNeeded && !currentKey();
  el.keywarn.hidden = !needsKey;
  if (needsKey) {
    el.keywarnText.textContent = 'No API key for ' + p.name + '.';
  }
}

function updateCapabilityUI() {
  const m = state.model || {};
  const visionOk = m.vision !== false;
  el.btnImage.disabled = !visionOk;
  el.btnShot.disabled = !visionOk;
  el.btnImage.title = visionOk
    ? 'Attach an image (or just paste one)'
    : (m.label || m.id) + ' has no vision support';
  el.btnShot.title = visionOk
    ? 'Attach a screenshot of this tab'
    : (m.label || m.id) + ' has no vision support';

  el.btnPage.classList.toggle('is-active', !!state.settings.usePage);
  el.btnPage.setAttribute('aria-pressed', state.settings.usePage ? 'true' : 'false');
  el.ctxStrip.hidden = !state.settings.usePage;
  refreshTabChip();
}

async function refreshTabChip() {
  if (!state.settings.usePage) return;
  try {
    const info = await B.runtime.sendMessage({ type: 'scai:tabInfo' });
    state.tab = info || null;
    if (info && info.ok) {
      el.ctxText.textContent = (state.settings.fullPage ? 'Reading all of: ' : 'Reading: ') +
        (info.title || info.url || 'this page');
      el.ctxText.title = info.url || '';
    } else {
      el.ctxText.textContent = 'This page can\'t be read';
      el.ctxText.title = '';
    }
  } catch (e) {
    el.ctxText.textContent = 'Reading this page';
  }
}

async function selectProvider(id) {
  const p = findProvider(state.providers, id);
  if (!p) return;
  const firstModel = (p.models[0] && p.models[0].id) || '';
  state.settings = await store.patchSettings({
    providerId: p.id,
    model: firstModel,
    maxTokens: Math.min(state.settings.maxTokens, p.defaultMaxTokens || 8192)
  });
  resolveSelection();
  fillProviders();
  fillModels();
  updateKeyWarning();
  updateCapabilityUI();
  syncSettingsPanel();
}

async function selectModel(value) {
  if (value === '__custom__') {
    const typed = prompt('Model ID for ' + state.provider.name + ':', state.settings.model || '');
    if (!typed) { el.model.value = state.settings.model || ''; return; }
    state.settings = await store.patchSettings({ model: typed.trim() });
  } else {
    state.settings = await store.patchSettings({ model: value });
  }
  resolveSelection();
  fillModels();
  updateCapabilityUI();
  syncSettingsPanel();
}

/* ============================================================
   Transcript rendering
   ============================================================ */

const SUGGESTIONS = [
  { icon: 'quote', label: 'Summarise this page', prompt: 'Summarise this page in five bullet points.', page: true },
  { icon: 'spark', label: 'Explain the key idea', prompt: 'Explain the main idea of this page in plain language.', page: true },
  { icon: 'camera', label: 'Read what I see', prompt: 'What is shown in this screenshot?', shot: true }
];

function renderSuggestions() {
  el.suggestions.textContent = '';
  for (const s of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggestion';
    b.appendChild(icon(ICONS[s.icon], { width: 1.9 }));
    const span = document.createElement('span');
    span.textContent = s.label;
    b.appendChild(span);
    b.addEventListener('click', async () => {
      if (s.page && !state.settings.usePage) await togglePage(true);
      if (s.shot) await attachScreenshot();
      el.prompt.value = s.prompt;
      autosize();
      el.prompt.focus();
      if (!s.shot) submit();
    });
    el.suggestions.appendChild(b);
  }
}

function updateEmptyState() {
  const has = state.chat && state.chat.messages.length;
  el.empty.hidden = !!has;
  if (!has) {
    const p = state.provider;
    el.emptySub.textContent = p && !p.noKeyNeeded && !currentKey()
      ? 'Add your ' + p.name + ' API key to get started.'
      : 'Bring your own key, pick a model, and ask away.';
  }
}

function metaButton(label, iconName, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'meta-btn';
  b.appendChild(icon(ICONS[iconName], { width: 2 }));
  const s = document.createElement('span');
  s.textContent = label;
  b.appendChild(s);
  b.addEventListener('click', onClick);
  return b;
}

function contextChip(ctx) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'msg-ctx';
  chip.appendChild(icon(ICONS[ctx.kind === 'selection' ? 'quote' : 'eye'], { width: 2 }));
  const s = document.createElement('span');
  s.className = 'truncate';
  s.textContent = ctx.label;
  chip.appendChild(s);
  chip.title = 'Click to see exactly what was sent';
  chip.addEventListener('click', () => {
    const open = chip.nextElementSibling;
    if (open && open.classList.contains('thinking')) { open.remove(); return; }
    const d = document.createElement('details');
    d.className = 'thinking';
    d.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'Context sent to the model';
    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.textContent = ctx.text;
    d.appendChild(sum);
    d.appendChild(body);
    chip.after(d);
  });
  return chip;
}

function thumbStrip(images) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-thumbs';
  for (const img of images) {
    const i = document.createElement('img');
    i.src = img.dataUrl || ('data:' + img.mediaType + ';base64,' + img.data);
    i.alt = img.name || 'attached image';
    i.title = img.name || '';
    wrap.appendChild(i);
  }
  return wrap;
}

/**
 * Build the DOM for one stored message. Returns handles the streaming
 * code can keep writing into.
 */
function renderMessage(msg, index) {
  const row = document.createElement('div');
  row.className = 'msg msg-' + (msg.error ? 'error' : msg.role);
  row.dataset.index = index;

  if (msg.role === 'user') {
    if (msg.context) row.appendChild(contextChip(msg.context));
    if (msg.images && msg.images.length) row.appendChild(thumbStrip(msg.images));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content || '';
    row.appendChild(bubble);
    el.thread.appendChild(row);
    return { row, bubble };
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  let thinkBody = null;
  if (msg.thinking) {
    const d = document.createElement('details');
    d.className = 'thinking';
    const sum = document.createElement('summary');
    sum.textContent = 'Reasoning';
    thinkBody = document.createElement('div');
    thinkBody.className = 'thinking-body';
    thinkBody.textContent = msg.thinking;
    d.appendChild(sum);
    d.appendChild(thinkBody);
    bubble.appendChild(d);
  }

  const body = document.createElement('div');
  body.className = 'md';
  if (msg.error) body.textContent = msg.content || '';
  else md.render(msg.content || '', body);
  bubble.appendChild(body);
  row.appendChild(bubble);

  if (!msg.error) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const usage = document.createElement('span');
    usage.className = 'usage';
    if (state.settings.showUsage && msg.usage) {
      const inTok = msg.usage.input_tokens, outTok = msg.usage.output_tokens;
      const bits = [];
      if (inTok != null) bits.push(fmtInt(inTok) + ' in');
      if (outTok != null) bits.push(fmtInt(outTok) + ' out');
      if (msg.modelLabel) bits.push(msg.modelLabel);
      usage.textContent = bits.join(' · ');
    }
    meta.appendChild(usage);

    meta.appendChild(metaButton('Copy', 'copy', () => {
      navigator.clipboard.writeText(msg.content || '').then(() => toast('Copied'));
    }));
    if (index === state.chat.messages.length - 1) {
      meta.appendChild(metaButton('Retry', 'redo', () => retryLast()));
    }
    row.appendChild(meta);
  }

  el.thread.appendChild(row);
  return { row, bubble, body, thinkBody };
}

function renderThread(keepScroll) {
  const prevTop = el.thread.scrollTop;
  Array.from(el.thread.children).forEach(c => { if (c !== el.empty) c.remove(); });
  const msgs = (state.chat && state.chat.messages) || [];
  msgs.forEach((m, i) => renderMessage(m, i));
  updateEmptyState();
  if (keepScroll) el.thread.scrollTop = prevTop;
  else scrollDown(true);
}

/* ============================================================
   Attachments
   ============================================================ */

function renderAttachments() {
  el.attachments.textContent = '';
  el.attachments.hidden = !state.attachments.length;
  for (const img of state.attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'attach';
    wrap.title = img.name || '';
    const i = document.createElement('img');
    i.src = img.dataUrl;
    i.alt = img.name || 'attachment';
    wrap.appendChild(i);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'attach-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Remove attachment');
    x.addEventListener('click', () => {
      state.attachments = state.attachments.filter(a => a.id !== img.id);
      renderAttachments();
      updateSendState();
    });
    wrap.appendChild(x);
    el.attachments.appendChild(wrap);
  }
}

function addImages(images) {
  const ok = images.filter(Boolean);
  if (!ok.length) return;
  if (state.model && state.model.vision === false) {
    toast((state.model.label || state.model.id) + ' has no vision support');
    return;
  }
  // Base64 grows ~33%; keep the request sane and the chat store small.
  const MAX = 4;
  for (const img of ok) {
    if (state.attachments.length >= MAX) { toast('Up to ' + MAX + ' images per message'); break; }
    state.attachments.push(img);
  }
  renderAttachments();
  updateSendState();
}

async function attachScreenshot() {
  if (state.model && state.model.vision === false) {
    toast((state.model.label || state.model.id) + ' has no vision support');
    return;
  }
  el.btnShot.disabled = true;
  try {
    const res = await B.runtime.sendMessage({ type: 'scai:screenshot' });
    if (!res || !res.ok) { toast((res && res.error) || 'Screenshot failed'); return; }
    const img = dataUrlToImage(res.dataUrl, 'screenshot — ' + (res.title || 'tab'), 'screenshot');
    if (img) { addImages([img]); toast('Screenshot attached'); }
  } finally {
    el.btnShot.disabled = false;
    updateCapabilityUI();
  }
}

/* ============================================================
   Page context
   ============================================================ */

async function togglePage(force) {
  const next = typeof force === 'boolean' ? force : !state.settings.usePage;
  state.settings = await store.patchSettings({ usePage: next });
  updateCapabilityUI();
  syncSettingsPanel();
  if (next) {
    await refreshTabChip();
    if (state.tab && !state.tab.ok) toast('scAI can\'t read this kind of page');
  }
}

/**
 * Capture page context for one message.
 * Returns { kind, label, text } or null.
 */
async function capturePageContext() {
  if (!state.settings.usePage) return null;

  const res = await B.runtime.sendMessage({ type: 'scai:readPage' });
  if (!res || !res.ok) {
    toast((res && res.error) ? res.error.split('\n')[0] : 'Could not read the page');
    return null;
  }

  const limit = parseInt(state.settings.contextChars, 10) || 12000;
  const sel = (res.selection || '').trim();
  const useSel = state.settings.useSelection && sel.length > 40;
  const full = !!state.settings.fullPage;

  const head = [
    '<page_context>',
    'The user is looking at this page. Ground your answer in it.',
    'Title: ' + (res.title || '(untitled)'),
    'URL: ' + (res.url || '')
  ];
  if (res.description) head.push('Description: ' + res.description);

  let text, kind, label;
  if (useSel) {
    kind = 'selection';
    label = 'Selected text · ' + (res.title || 'page');
    head.push('', 'The user has highlighted this passage:', '<selection>',
      clampMiddle(sel, limit), '</selection>');
  } else {
    kind = 'page';
    label = (full ? 'Full page · ' : 'Page · ') + (res.title || res.url || 'this page');
    if (res.outline) head.push('', 'Outline:', res.outline);
    const bodyText = full ? (res.fullText || res.text || '') : (res.text || '');
    head.push('');
    if (full) head.push('Full page text, including navigation and footers:');
    head.push('<page_text>', clampMiddle(bodyText, limit), '</page_text>');
  }
  head.push('</page_context>');
  text = head.join('\n');

  return { kind, label, text };
}

/* ============================================================
   Sending
   ============================================================ */

function updateSendState() {
  const hasInput = el.prompt.value.trim().length > 0 || state.attachments.length > 0;
  el.send.disabled = state.streaming || !hasInput;
  el.send.hidden = state.streaming;
  el.stop.hidden = !state.streaming;
}

function buildWireMessages(context) {
  const turns = Math.max(2, parseInt(state.settings.historyTurns, 10) || 20);
  const msgs = state.chat.messages
    .filter(m => !m.error && (m.content || (m.images && m.images.length)))
    .slice(-turns)
    .map(m => ({
      role: m.role,
      content: m.content || '',
      images: (m.images || []).map(i => ({ mediaType: i.mediaType, data: i.data }))
    }));

  // Page context rides on the final user turn so it never poisons the
  // cached prefix of earlier turns.
  if (context && msgs.length) {
    const last = msgs[msgs.length - 1];
    last.content = context.text + '\n\n' + last.content;
  }

  // Some endpoints reject an empty string alongside images.
  for (const m of msgs) {
    if (!m.content && m.images.length) m.content = 'Look at this image.';
  }
  return msgs;
}

async function persist() {
  if (!state.chat) return;
  if (!state.chat.title) state.chat.title = store.titleFor(state.chat);
  await store.saveChat(state.chat);
}

async function runCompletion() {
  const provider = state.provider;
  const model = state.model;
  if (!provider || !model) { toast('Pick a provider and model first'); return; }

  const apiKey = currentKey();
  if (!provider.noKeyNeeded && !apiKey) {
    openPanel('panel-settings');
    toast('Add your ' + provider.name + ' API key');
    return;
  }

  const context = state.chat.messages.length
    ? state.chat.messages[state.chat.messages.length - 1].context
    : null;

  state.streaming = true;
  state.controller = new AbortController();
  updateSendState();
  el.hint.textContent = 'Thinking…';

  // Placeholder assistant turn, streamed into directly.
  const placeholder = {
    role: 'assistant',
    content: '',
    thinking: '',
    usage: null,
    modelLabel: model.label || model.id
  };
  state.chat.messages.push(placeholder);
  const idx = state.chat.messages.length - 1;

  const row = document.createElement('div');
  row.className = 'msg msg-assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  let thinkDetails = null, thinkBody = null;
  const body = document.createElement('div');
  body.className = 'md';
  const dots = document.createElement('div');
  dots.className = 'dots';
  dots.appendChild(document.createElement('i'));
  dots.appendChild(document.createElement('i'));
  dots.appendChild(document.createElement('i'));
  body.appendChild(dots);
  bubble.appendChild(body);
  row.appendChild(bubble);
  el.thread.appendChild(row);
  scrollDown(true);

  let text = '', thinking = '', usage = null, first = true;
  let raf = null;

  function paint() {
    raf = null;
    md.render(text, body);
    scrollDown();
  }
  function schedule() {
    if (raf == null) raf = requestAnimationFrame(paint);
  }

  try {
    const result = await api.complete({
      provider,
      model,
      apiKey,
      settings: state.settings,
      system: state.settings.systemPrompt,
      messages: buildWireMessages(context),
      signal: state.controller.signal,
      onText(chunk) {
        if (first) { first = false; body.textContent = ''; el.hint.textContent = 'Writing…'; }
        text += chunk;
        schedule();
      },
      onThinking(chunk) {
        if (!state.settings.showThinking) { thinking += chunk; return; }
        if (!thinkDetails) {
          thinkDetails = document.createElement('details');
          thinkDetails.className = 'thinking';
          thinkDetails.open = true;
          const sum = document.createElement('summary');
          sum.textContent = 'Reasoning';
          thinkBody = document.createElement('div');
          thinkBody.className = 'thinking-body';
          thinkDetails.appendChild(sum);
          thinkDetails.appendChild(thinkBody);
          bubble.insertBefore(thinkDetails, body);
        }
        thinking += chunk;
        thinkBody.textContent = thinking;
        scrollDown();
      },
      onUsage(u) { usage = u; }
    });

    if (raf != null) cancelAnimationFrame(raf);
    text = result.text || text;
    thinking = result.thinking || thinking;
    usage = result.usage || usage;

    if (!text.trim()) {
      text = thinking.trim()
        ? '_(The model returned only reasoning, no answer. Try again, or turn reasoning off.)_'
        : '_(Empty response.)_';
    }

    Object.assign(placeholder, { content: text, thinking, usage });
    if (thinkDetails) thinkDetails.open = false;
    await persist();
    renderThread(false);
  } catch (err) {
    if (raf != null) cancelAnimationFrame(raf);
    const aborted = err && err.name === 'AbortError';
    if (aborted && text.trim()) {
      Object.assign(placeholder, { content: text + '\n\n_(stopped)_', thinking, usage });
      await persist();
    } else {
      state.chat.messages.splice(idx, 1);
      if (!aborted) {
        state.chat.messages.push({
          role: 'assistant',
          error: true,
          content: (err && err.message) ? err.message : String(err)
        });
        await persist();
      }
    }
    renderThread(false);
  } finally {
    state.streaming = false;
    state.controller = null;
    el.hint.textContent = '';
    updateSendState();
    renderHistory();
  }
}

async function submit() {
  if (state.streaming) return;
  const text = el.prompt.value.trim();
  if (!text && !state.attachments.length) return;

  if (!state.chat) state.chat = store.newChat();

  el.hint.textContent = state.settings.usePage ? 'Reading page…' : '';
  const context = await capturePageContext();

  state.chat.messages.push({
    role: 'user',
    content: text,
    images: state.attachments.slice(),
    context
  });

  el.prompt.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  renderThread(false);
  await persist();
  await runCompletion();
}

async function retryLast() {
  if (state.streaming || !state.chat) return;
  const msgs = state.chat.messages;
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
  renderThread(false);
  await persist();
  if (msgs.length) await runCompletion();
}

/* ============================================================
   Panels
   ============================================================ */

function openPanel(id) {
  el.panelHistory.hidden = id !== 'panel-history';
  el.panelSettings.hidden = id !== 'panel-settings';
  if (id === 'panel-history') renderHistory();
  if (id === 'panel-settings') syncSettingsPanel();
}

function closePanels() {
  el.panelHistory.hidden = true;
  el.panelSettings.hidden = true;
}

/* ---------------- history ---------------- */

async function renderHistory() {
  const chats = await store.get('chats');
  el.historyList.textContent = '';

  if (!chats.length) {
    const p = document.createElement('p');
    p.className = 'hist-empty';
    p.textContent = 'No saved chats yet.';
    el.historyList.appendChild(p);
    return;
  }

  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'hist-item' + (state.chat && chat.id === state.chat.id ? ' is-active' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'hist-open';
    const title = document.createElement('span');
    title.className = 'hist-title truncate';
    title.textContent = store.titleFor(chat);
    const sub = document.createElement('span');
    sub.className = 'hist-sub';
    const count = (chat.messages || []).filter(m => m.role === 'user').length;
    sub.textContent = count + (count === 1 ? ' message' : ' messages') + ' · ' + relTime(chat.updatedAt);
    open.appendChild(title);
    open.appendChild(sub);
    open.addEventListener('click', () => loadChat(chat.id));
    item.appendChild(open);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.setAttribute('aria-label', 'Delete chat');
    del.title = 'Delete chat';
    del.appendChild(icon(ICONS.trash, { width: 1.9 }));
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await store.deleteChat(chat.id);
      if (state.chat && state.chat.id === chat.id) {
        state.chat = store.newChat();
        renderThread(false);
      }
      renderHistory();
    });
    item.appendChild(del);

    el.historyList.appendChild(item);
  }
}

async function loadChat(id) {
  const chats = await store.get('chats');
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  state.chat = chat;
  await store.set({ activeChat: id });
  closePanels();
  renderThread(false);
}

async function newChat() {
  if (state.controller) state.controller.abort();
  state.chat = store.newChat();
  state.attachments = [];
  renderAttachments();
  await store.set({ activeChat: null });
  closePanels();
  renderThread(false);
  el.prompt.focus();
}

/* ---------------- settings panel ---------------- */

const S = {
  key: $('s-key'),
  keyShow: $('s-key-show'),
  keyLabel: $('s-key-label'),
  keyLink: $('s-key-link'),
  usePage: $('s-use-page'),
  useSelection: $('s-use-selection'),
  fullPage: $('s-full-page'),
  contextChars: $('s-context-chars'),
  system: $('s-system'),
  systemReset: $('s-system-reset'),
  maxTokens: $('s-max-tokens'),
  historyTurns: $('s-history-turns'),
  thinking: $('s-thinking'),
  effort: $('s-effort'),
  showThinking: $('s-show-thinking'),
  sendTemp: $('s-send-temp'),
  temp: $('s-temp'),
  tempVal: $('s-temp-val'),
  showUsage: $('s-show-usage'),
  wrapThinking: $('wrap-thinking'),
  wrapEffort: $('wrap-effort'),
  wrapShowThinking: $('wrap-show-thinking'),
  wrapTemp: $('wrap-temp'),
  dock: $('s-dock')
};

function syncSettingsPanel() {
  const s = state.settings;
  const p = state.provider || {};
  const m = state.model || {};

  S.key.value = currentKey();
  S.key.type = 'password';
  S.keyShow.textContent = 'Show';
  S.keyLabel.textContent = p.name ? p.name + ' API key' : 'API key';
  S.key.placeholder = p.api === 'anthropic' ? 'sk-ant-…' : 'sk-…';
  S.key.disabled = !!p.noKeyNeeded;
  if (p.noKeyNeeded) S.key.placeholder = 'not required for ' + p.name;
  S.keyLink.href = p.keysUrl || '#';
  S.keyLink.hidden = !p.keysUrl;

  S.usePage.checked = !!s.usePage;
  S.dock.value = s.dock === 'sidebar' ? 'sidebar' : 'page';
  S.useSelection.checked = !!s.useSelection;
  S.fullPage.checked = !!s.fullPage;
  S.contextChars.value = String(s.contextChars);
  S.system.value = s.systemPrompt || '';
  S.maxTokens.value = s.maxTokens;
  S.historyTurns.value = s.historyTurns;
  S.thinking.value = s.thinking;
  S.effort.value = s.effort || '';
  S.showThinking.checked = !!s.showThinking;
  S.sendTemp.checked = !!s.sendTemperature;
  S.temp.value = s.temperature;
  S.tempVal.textContent = Number(s.temperature).toFixed(2);
  S.showUsage.checked = !!s.showUsage;

  // Capability-gated rows: hide what the selected model would 400 on.
  const anthropic = p.api === 'anthropic';
  const reasoningCapable = anthropic ? !!m.thinking : !!m.reasoning;
  S.wrapThinking.hidden = !anthropic || !m.thinking;
  S.wrapShowThinking.hidden = !reasoningCapable;
  S.wrapEffort.hidden = anthropic ? !m.effort : !m.reasoning;
  S.wrapTemp.hidden = anthropic || m.reasoning === true;
  // xhigh/max only exist on the Anthropic dialect.
  Array.from(S.effort.options).forEach(o => {
    o.hidden = !anthropic && (o.value === 'xhigh' || o.value === 'max');
  });
}

function bindSettings() {
  let keyTimer = null;
  S.key.addEventListener('input', () => {
    clearTimeout(keyTimer);
    keyTimer = setTimeout(async () => {
      state.keys = await store.setKey(state.settings.providerId, S.key.value.trim());
      updateKeyWarning();
      updateEmptyState();
    }, 300);
  });

  S.keyShow.addEventListener('click', () => {
    const show = S.key.type === 'password';
    S.key.type = show ? 'text' : 'password';
    S.keyShow.textContent = show ? 'Hide' : 'Show';
  });

  const patch = async (p) => { state.settings = await store.patchSettings(p); };

  S.usePage.addEventListener('change', async () => {
    await patch({ usePage: S.usePage.checked });
    updateCapabilityUI();
  });
  S.useSelection.addEventListener('change', () => patch({ useSelection: S.useSelection.checked }));
  S.fullPage.addEventListener('change', async () => {
    await patch({ fullPage: S.fullPage.checked });
    updateCapabilityUI();
  });

  S.dock.addEventListener('change', async () => {
    await patch({ dock: S.dock.value });
    // Background swaps the surfaces; this document may be the one
    // being torn down, so don't await anything after it.
    B.runtime.sendMessage({ type: 'scai:dockChanged' }).catch(() => {});
  });

  S.contextChars.addEventListener('change', () => patch({ contextChars: parseInt(S.contextChars.value, 10) }));

  S.system.addEventListener('change', () => patch({ systemPrompt: S.system.value }));
  S.systemReset.addEventListener('click', async () => {
    S.system.value = store.DEFAULT_SYSTEM_PROMPT;
    await patch({ systemPrompt: store.DEFAULT_SYSTEM_PROMPT });
    toast('System prompt reset');
  });

  S.maxTokens.addEventListener('change', () => {
    const v = Math.min(128000, Math.max(256, parseInt(S.maxTokens.value, 10) || 8192));
    S.maxTokens.value = v;
    patch({ maxTokens: v });
  });
  S.historyTurns.addEventListener('change', () => {
    const v = Math.min(100, Math.max(2, parseInt(S.historyTurns.value, 10) || 20));
    S.historyTurns.value = v;
    patch({ historyTurns: v });
  });

  S.thinking.addEventListener('change', () => patch({ thinking: S.thinking.value }));
  S.effort.addEventListener('change', () => patch({ effort: S.effort.value }));
  S.showThinking.addEventListener('change', () => patch({ showThinking: S.showThinking.checked }));
  S.sendTemp.addEventListener('change', () => patch({ sendTemperature: S.sendTemp.checked }));
  S.temp.addEventListener('input', () => {
    S.tempVal.textContent = Number(S.temp.value).toFixed(2);
  });
  S.temp.addEventListener('change', () => patch({ temperature: Number(S.temp.value) }));
  S.showUsage.addEventListener('change', async () => {
    await patch({ showUsage: S.showUsage.checked });
    renderThread(true);
  });
}

/* ============================================================
   Event wiring
   ============================================================ */

function bindEvents() {
  el.composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  el.prompt.addEventListener('input', () => { autosize(); updateSendState(); });
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  });

  // Paste images straight into the composer.
  el.prompt.addEventListener('paste', async (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = items
      .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
      .map(i => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addImages(await Promise.all(files.map(fileToImage)));
    toast(files.length === 1 ? 'Image attached' : files.length + ' images attached');
  });

  // Drag and drop images anywhere in the sidebar.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    el.dropVeil.hidden = false;
  });
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropVeil.hidden = true;
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropVeil.hidden = true;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    addImages(await Promise.all(files.map(fileToImage)));
  });

  el.btnImage.addEventListener('click', () => el.fileImage.click());
  el.fileImage.addEventListener('change', async () => {
    const files = Array.from(el.fileImage.files || []);
    el.fileImage.value = '';
    if (files.length) addImages(await Promise.all(files.map(fileToImage)));
  });

  el.btnShot.addEventListener('click', attachScreenshot);
  el.btnPage.addEventListener('click', () => togglePage());
  el.ctxOff.addEventListener('click', () => togglePage(false));

  el.stop.addEventListener('click', () => { if (state.controller) state.controller.abort(); });

  el.provider.addEventListener('change', () => selectProvider(el.provider.value));
  el.model.addEventListener('change', () => selectModel(el.model.value));

  $('btn-new').addEventListener('click', newChat);
  $('btn-history').addEventListener('click', () => {
    openPanel(el.panelHistory.hidden ? 'panel-history' : null);
  });
  $('btn-settings').addEventListener('click', () => {
    openPanel(el.panelSettings.hidden ? 'panel-settings' : null);
  });
  $('btn-full-options').addEventListener('click', () => {
    B.runtime.sendMessage({ type: 'scai:openOptions' });
  });

  // Only the embedded panel gets a close affordance — the rail
  // sidebar already has Firefox's own close button.
  el.btnClose.hidden = !EMBEDDED;
  el.btnClose.addEventListener('click', () => {
    if (EMBEDDED) parent.postMessage({ type: 'scai:closePanel' }, '*');
    else B.runtime.sendMessage({ type: 'scai:closeSelf' }).catch(() => {});
  });

  $('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('Delete every saved chat? This cannot be undone.')) return;
    await store.clearChats();
    state.chat = store.newChat();
    renderThread(false);
    renderHistory();
  });

  document.querySelectorAll('.panel-close').forEach(b => {
    b.addEventListener('click', closePanels);
  });

  el.keywarnAction.addEventListener('click', () => {
    openPanel('panel-settings');
    S.key.focus();
  });

  el.noticeOff.addEventListener('click', () => { el.notice.hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.streaming && state.controller) { state.controller.abort(); return; }
      if (!el.panelHistory.hidden || !el.panelSettings.hidden) { closePanels(); return; }
      // Nothing left to dismiss — close the panel itself.
      if (EMBEDDED) { parent.postMessage({ type: 'scai:closePanel' }, '*'); return; }
    }
    // Alt+Shift+A reaches the iframe rather than the browser when
    // focus is inside the panel, so honour it here too.
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'a' && EMBEDDED) {
      e.preventDefault();
      parent.postMessage({ type: 'scai:closePanel' }, '*');
      return;
    }
    // Ctrl/Cmd+K starts a new chat, matching most chat UIs.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      newChat();
    }
  });

  // The options page and other sidebar instances write to the same store.
  B.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.providers || changes.settings || changes.keys) {
      const all = await store.getAll();
      state.settings = all.settings;
      state.keys = all.keys;
      state.providers = resolveProviders(all.providers);
      resolveSelection();
      fillProviders();
      fillModels();
      updateKeyWarning();
      updateCapabilityUI();
      if (!el.panelSettings.hidden) syncSettingsPanel();
    }
  });

  B.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'scai:pending') consumePending();
    // The background page owns browser.tabs and tells us when the
    // active tab moved, so the chip stays honest even where this
    // document has no tabs API of its own.
    if (msg.type === 'scai:tabChanged') refreshTabChip();
    if (msg.type === 'scai:dockNotice' && msg.text) showNotice(msg.text);
  });

  // Keep the "reading: <title>" chip honest as the user moves around.
  // browser.tabs is not reliably exposed to this document (the in-page
  // iframe host in particular), and an unguarded call here used to take
  // the whole of init() down with it. The background page watches tabs
  // for us and broadcasts scai:tabChanged; only subscribe directly when
  // the API really is present.
  try {
    if (B.tabs && B.tabs.onActivated && B.tabs.onUpdated) {
      B.tabs.onActivated.addListener(() => refreshTabChip());
      B.tabs.onUpdated.addListener((id, info) => {
        if (info.status === 'complete' || info.title) refreshTabChip();
      });
    }
  } catch (e) { /* background broadcasts cover us */ }
}

/**
 * The context menu stashes a prompt in the background page; pick it up
 * whenever the sidebar gains focus or is told to.
 */
async function consumePending() {
  let pending = null;
  try {
    pending = await B.runtime.sendMessage({ type: 'scai:takePending' });
  } catch (e) { return; }
  if (!pending) return;

  if (pending.kind === 'page') {
    await togglePage(true);
    el.prompt.value = 'Summarise this page.';
  } else {
    await togglePage(true);
    el.prompt.value = pending.text
      ? 'About this passage:\n\n"' + pending.text.slice(0, 600) + '"\n\n'
      : '';
  }
  autosize();
  updateSendState();
  el.prompt.focus();
}

/* ============================================================
   Boot
   ============================================================ */

async function init() {
  if (EMBEDDED) document.body.classList.add('embedded');

  const all = await store.getAll();
  state.settings = all.settings;
  state.keys = all.keys;
  state.providers = resolveProviders(all.providers);
  resolveSelection();

  state.chat = (all.activeChat && all.chats.find(c => c.id === all.activeChat)) || store.newChat();

  fillProviders();
  fillModels();
  renderSuggestions();
  bindSettings();
  bindEvents();

  updateKeyWarning();
  updateCapabilityUI();
  renderThread(false);
  updateSendState();
  autosize();

  await consumePending();
  await settleDock();
  window.addEventListener('focus', consumePending);
  el.prompt.focus();
}

/**
 * Firefox restores its own sidebar across restarts, and the sidebar
 * switcher can open scAI's rail panel directly — neither route goes
 * through the background's showPanel(), which is why scAI could appear
 * on the left despite a "docked right" preference. Tell the background
 * we booted so it can move us, and surface any explanation it left.
 */
async function settleDock() {
  try {
    if (!EMBEDDED) {
      const res = await B.runtime.sendMessage({ type: 'scai:railBooted' });
      // Moved into the page panel: that document shows the state now.
      if (res && res.moved) return;
      if (res && res.notice) { showNotice(res.notice); return; }
    }
    const pending = await B.runtime.sendMessage({ type: 'scai:takeDockNotice' });
    if (pending && pending.notice) showNotice(pending.notice);
  } catch (e) { /* background asleep; nothing to settle */ }
}

init().catch(err => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:1rem;font-size:.8rem;color:#8c3423;white-space:pre-wrap';
  pre.textContent = 'scAI failed to start:\n' + (err && err.stack ? err.stack : String(err));
  document.body.prepend(pre);
});
