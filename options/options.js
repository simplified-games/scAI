/* ============================================================
   scAI — options page controller

   Manages the provider list: edit a preset's base URL / model list,
   or add an entirely new provider by naming its API dialect.
   ============================================================ */
'use strict';

const B = typeof browser !== 'undefined' ? browser : chrome;
const P = window.scaiProviders;
const store = window.scaiStore;
const api = window.scaiApi;

const $ = id => document.getElementById(id);

const state = {
  providers: [],   // resolved (presets + user entries)
  saved: [],       // raw stored overrides
  keys: {},
  editing: null    // working copy inside the modal
};

function toast(msg) {
  const prev = document.querySelector('.toast');
  if (prev) prev.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ============================================================
   Provider list
   ============================================================ */

function renderList() {
  const list = $('provider-list');
  list.textContent = '';

  for (const p of state.providers) {
    const row = document.createElement('div');
    row.className = 'prov';

    const mark = document.createElement('div');
    mark.className = 'prov-mark';
    mark.textContent = (p.name || '?').slice(0, 2);
    row.appendChild(mark);

    const text = document.createElement('div');
    text.className = 'prov-text';

    const name = document.createElement('div');
    name.className = 'prov-name';
    name.appendChild(document.createTextNode(p.name));

    const dialect = document.createElement('span');
    dialect.className = 'pill';
    dialect.textContent = p.api === 'anthropic' ? 'Messages API' : 'OpenAI-compatible';
    name.appendChild(dialect);

    if (!p.preset) {
      const custom = document.createElement('span');
      custom.className = 'pill pill-accent';
      custom.textContent = 'custom';
      name.appendChild(custom);
    }
    text.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'prov-sub truncate';
    sub.textContent = p.baseUrl || '(no base URL)';
    text.appendChild(sub);

    const meta = document.createElement('div');
    meta.className = 'prov-meta';
    const hasKey = !!state.keys[p.id];
    const keyBit = document.createElement('span');
    keyBit.className = (hasKey || p.noKeyNeeded) ? 'dot-ok' : 'dot-no';
    keyBit.textContent = p.noKeyNeeded ? 'no key needed' : (hasKey ? 'key set' : 'no key');
    meta.appendChild(keyBit);
    meta.appendChild(document.createTextNode(
      ' · ' + (p.models.length || 0) + (p.models.length === 1 ? ' model' : ' models')
    ));
    text.appendChild(meta);

    row.appendChild(text);

    const edit = document.createElement('button');
    edit.className = 'btn btn-sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openModal(p));
    row.appendChild(edit);

    list.appendChild(row);
  }
}

/* ============================================================
   Modal
   ============================================================ */

const F = {
  modal: $('modal'),
  scrim: $('modal-scrim'),
  title: $('modal-title'),
  name: $('f-name'),
  api: $('f-api'),
  apiHint: $('f-api-hint'),
  base: $('f-base'),
  key: $('f-key'),
  nokey: $('f-nokey'),
  maxTokens: $('f-maxtokens'),
  rows: $('model-rows'),
  del: $('btn-delete')
};

const API_HINTS = {
  anthropic: 'POST {base}/messages with x-api-key. scAI adds anthropic-version and the ' +
             'anthropic-dangerous-direct-browser-access header automatically.',
  openai: 'POST {base}/chat/completions with an Authorization: Bearer header. Works for OpenRouter, ' +
          'Groq, Together, DeepSeek, Mistral, vLLM, Ollama, LM Studio, and most gateways.'
};

function modelRow(model) {
  const row = document.createElement('div');
  row.className = 'model-row';

  const id = document.createElement('input');
  id.className = 'input mono';
  id.placeholder = 'model-id';
  id.value = model.id || '';
  id.spellcheck = false;
  row.appendChild(id);

  const label = document.createElement('input');
  label.className = 'input m-label';
  label.placeholder = 'Display name (optional)';
  label.value = model.label && model.label !== model.id ? model.label : '';
  row.appendChild(label);

  const vis = document.createElement('label');
  vis.className = 'vision-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = model.vision !== false;
  vis.appendChild(box);
  vis.appendChild(document.createTextNode('vision'));
  row.appendChild(vis);

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'row-x';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Remove model');
  x.addEventListener('click', () => { row.remove(); syncEmptyModels(); });
  row.appendChild(x);

  row._read = () => {
    const mid = id.value.trim();
    if (!mid) return null;
    const out = { id: mid, label: label.value.trim() || mid, vision: box.checked };
    // Preserve reasoning flags the presets carry so capability gating survives an edit.
    if (model.thinking) out.thinking = model.thinking;
    if (model.effort) out.effort = model.effort;
    if (model.reasoning) out.reasoning = model.reasoning;
    if (model.noTemp) out.noTemp = model.noTemp;
    return out;
  };

  return row;
}

function syncEmptyModels() {
  const existing = F.rows.querySelector('.models-empty');
  const hasRows = F.rows.querySelector('.model-row');
  if (!hasRows && !existing) {
    const p = document.createElement('p');
    p.className = 'models-empty';
    p.textContent = 'No models listed. Add a row, fetch from the API, or type an ID in the sidebar.';
    F.rows.appendChild(p);
  } else if (hasRows && existing) {
    existing.remove();
  }
}

function renderModelRows(models) {
  F.rows.textContent = '';
  for (const m of models) F.rows.appendChild(modelRow(m));
  syncEmptyModels();
}

function openModal(provider) {
  const isNew = !provider;
  state.editing = provider
    ? P.clone(provider)
    : { id: null, name: '', api: 'openai', baseUrl: '', models: [], defaultMaxTokens: 8192, preset: false };

  const e = state.editing;
  F.title.textContent = isNew ? 'Add provider' : 'Edit ' + e.name;
  F.name.value = e.name || '';
  F.api.value = e.api;
  F.api.disabled = !!e.preset;
  F.apiHint.textContent = API_HINTS[e.api];
  F.base.value = e.baseUrl || '';
  F.key.value = e.id ? (state.keys[e.id] || '') : '';
  F.key.type = 'password';
  F.nokey.checked = !!e.noKeyNeeded;
  F.key.disabled = F.nokey.checked;
  F.maxTokens.value = e.defaultMaxTokens || 8192;
  F.del.textContent = e.preset ? 'Reset to defaults' : 'Delete';
  F.del.hidden = isNew;

  renderModelRows(e.models || []);

  F.scrim.hidden = false;
  F.modal.hidden = false;
  F.name.focus();
}

function closeModal() {
  F.modal.hidden = true;
  F.scrim.hidden = true;
  state.editing = null;
}

function readModal() {
  const e = state.editing;
  const models = Array.from(F.rows.querySelectorAll('.model-row'))
    .map(r => r._read())
    .filter(Boolean);

  return {
    id: e.id,
    preset: e.preset,
    name: F.name.value.trim(),
    api: F.api.value,
    baseUrl: F.base.value.trim().replace(/\/+$/, ''),
    noKeyNeeded: F.nokey.checked,
    defaultMaxTokens: Math.min(128000, Math.max(256, parseInt(F.maxTokens.value, 10) || 8192)),
    models
  };
}

async function saveModal() {
  const draft = readModal();

  if (!draft.name) { toast('Give the provider a name'); F.name.focus(); return; }
  if (!draft.baseUrl) { toast('A base URL is required'); F.base.focus(); return; }
  if (!/^https?:\/\//i.test(draft.baseUrl)) { toast('Base URL must start with http:// or https://'); return; }

  const id = draft.id || P.newProviderId(state.providers, draft.name);

  const saved = state.saved.slice();
  const i = saved.findIndex(p => p.id === id);
  const entry = {
    id,
    name: draft.name,
    api: draft.api,
    baseUrl: draft.baseUrl,
    models: draft.models,
    defaultMaxTokens: draft.defaultMaxTokens,
    noKeyNeeded: draft.noKeyNeeded
  };
  if (i >= 0) saved[i] = entry; else saved.push(entry);

  await store.set({ providers: saved });
  const key = F.key.value.trim();
  if (!draft.noKeyNeeded) state.keys = await store.setKey(id, key);

  await reload();
  closeModal();
  toast(draft.id ? 'Provider updated' : 'Provider added');
}

async function deleteProvider() {
  const e = state.editing;
  if (!e || !e.id) return;

  if (e.preset) {
    if (!confirm('Reset ' + e.name + ' to its built-in defaults? Your API key is kept.')) return;
    await store.set({ providers: state.saved.filter(p => p.id !== e.id) });
  } else {
    if (!confirm('Delete ' + e.name + ' and its API key?')) return;
    await store.set({ providers: state.saved.filter(p => p.id !== e.id) });
    state.keys = await store.setKey(e.id, '');
    // Fall back to the first provider if the active one just vanished.
    const settings = await store.get('settings');
    if (settings.providerId === e.id) {
      await store.patchSettings({ providerId: 'anthropic', model: 'claude-opus-5' });
    }
  }

  await reload();
  closeModal();
  toast(e.preset ? 'Reset to defaults' : 'Provider deleted');
}

async function fetchModels() {
  const draft = readModal();
  if (!draft.baseUrl) { toast('Enter a base URL first'); return; }

  const btn = $('btn-fetch-models');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const models = await api.listModels(
      { name: draft.name || 'this provider', api: draft.api, baseUrl: draft.baseUrl },
      F.key.value.trim()
    );
    if (!models.length) { toast('The endpoint returned no models'); return; }
    // Keep any hand-tuned rows the user already had for these IDs.
    const existing = new Map(draft.models.map(m => [m.id, m]));
    renderModelRows(models.map(m => Object.assign({}, m, existing.get(m.id) || {})));
    toast(models.length + ' models loaded');
  } catch (err) {
    toast((err && err.message ? err.message : String(err)).split('\n')[0]);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch from API';
  }
}

/* ============================================================
   Data actions
   ============================================================ */

async function exportSettings() {
  const all = await store.getAll();
  const payload = {
    exportedAt: new Date().toISOString(),
    settings: all.settings,
    providers: all.providers,
    note: 'API keys are deliberately excluded from this export.'
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scai-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ============================================================
   Boot
   ============================================================ */

async function reload() {
  const all = await store.getAll();
  state.saved = all.providers;
  state.keys = all.keys;
  state.providers = P.resolveProviders(all.providers);
  renderList();
}

function bind() {
  $('btn-add').addEventListener('click', () => openModal(null));
  $('btn-save').addEventListener('click', saveModal);
  $('btn-cancel').addEventListener('click', closeModal);
  $('modal-close').addEventListener('click', closeModal);
  F.scrim.addEventListener('click', closeModal);
  F.del.addEventListener('click', deleteProvider);

  $('btn-add-model').addEventListener('click', () => {
    const empty = F.rows.querySelector('.models-empty');
    if (empty) empty.remove();
    const row = modelRow({});
    F.rows.appendChild(row);
    row.querySelector('input').focus();
  });
  $('btn-fetch-models').addEventListener('click', fetchModels);

  F.api.addEventListener('change', () => { F.apiHint.textContent = API_HINTS[F.api.value]; });
  F.nokey.addEventListener('change', () => {
    F.key.disabled = F.nokey.checked;
    if (F.nokey.checked) F.key.value = '';
  });

  $('btn-export').addEventListener('click', exportSettings);

  $('btn-forget-keys').addEventListener('click', async () => {
    if (!confirm('Remove every stored API key?')) return;
    await store.set({ keys: {} });
    await reload();
    toast('All API keys removed');
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset scAI completely? Settings, keys, and every saved chat will be deleted.')) return;
    await B.storage.local.clear();
    await reload();
    toast('scAI reset');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !F.modal.hidden) closeModal();
  });
}

reload().then(bind).catch(err => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:1rem;color:#8c3423;white-space:pre-wrap';
  pre.textContent = 'scAI options failed to load:\n' + (err && err.stack ? err.stack : String(err));
  document.body.prepend(pre);
});
