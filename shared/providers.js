/* ============================================================
   scAI — provider registry
   Two API dialects only:
     'anthropic' → POST {baseUrl}/messages   (x-api-key)
     'openai'    → POST {baseUrl}/chat/completions (Bearer)
   Everything else (OpenRouter, Groq, Together, Ollama, LM Studio,
   vLLM, DeepSeek, Mistral…) speaks the 'openai' dialect, so users
   can add their own provider with just a name + base URL + key.
   ============================================================ */
(function (root) {
  'use strict';

  // Model capability flags:
  //   vision    – accepts image content blocks
  //   thinking  – 'adaptive' | 'budget' | null   (Anthropic reasoning style)
  //   effort    – supports output_config.effort
  //   noTemp    – rejects temperature/top_p (Anthropic 4.7+ / 5-series)
  const A = (id, label, extra) => Object.assign(
    { id, label, vision: true, thinking: 'adaptive', effort: true, noTemp: true }, extra || {}
  );

  const PRESETS = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      keysUrl: 'https://console.anthropic.com/settings/keys',
      defaultMaxTokens: 32000,
      models: [
        A('claude-opus-5', 'Claude Opus 5'),
        A('claude-sonnet-5', 'Claude Sonnet 5'),
        A('claude-opus-4-8', 'Claude Opus 4.8'),
        A('claude-opus-4-7', 'Claude Opus 4.7'),
        A('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
        A('claude-haiku-4-5', 'Claude Haiku 4.5', { thinking: 'budget', effort: false, noTemp: false }),
        A('claude-fable-5', 'Claude Fable 5')
      ]
    },
    {
      id: 'openai',
      name: 'OpenAI',
      api: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      keysUrl: 'https://platform.openai.com/api-keys',
      defaultMaxTokens: 8192,
      models: [
        { id: 'gpt-4.1', label: 'GPT-4.1', vision: true },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', vision: true },
        { id: 'gpt-4o', label: 'GPT-4o', vision: true },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true },
        { id: 'o4-mini', label: 'o4-mini', vision: true, reasoning: true }
      ]
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      api: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      keysUrl: 'https://openrouter.ai/keys',
      defaultMaxTokens: 8192,
      models: [
        { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', vision: true },
        { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', vision: true },
        { id: 'openai/gpt-4.1', label: 'GPT-4.1', vision: true },
        { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', vision: true },
        { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }
      ]
    },
    {
      id: 'groq',
      name: 'Groq',
      api: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      keysUrl: 'https://console.groq.com/keys',
      defaultMaxTokens: 8192,
      models: [
        { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
        { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (instant)' }
      ]
    },
    {
      id: 'ollama',
      name: 'Ollama (local)',
      api: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      keysUrl: 'https://ollama.com/download',
      noKeyNeeded: true,
      defaultMaxTokens: 4096,
      models: [
        { id: 'llama3.2', label: 'llama3.2' },
        { id: 'qwen2.5', label: 'qwen2.5' },
        { id: 'llava', label: 'llava (vision)', vision: true }
      ]
    },
    {
      id: 'lmstudio',
      name: 'LM Studio (local)',
      api: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      noKeyNeeded: true,
      defaultMaxTokens: 4096,
      models: []
    }
  ];

  const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /**
   * Merge the built-in presets with the user's saved provider list.
   * Saved entries win on baseUrl / models / name so edits stick, but a
   * preset's api dialect and metadata are re-applied from code.
   */
  function resolveProviders(saved) {
    const savedList = Array.isArray(saved) ? saved : [];
    const byId = new Map(savedList.map(p => [p.id, p]));
    const out = [];

    for (const preset of PRESETS) {
      const s = byId.get(preset.id);
      byId.delete(preset.id);
      if (s && s.hidden) continue;
      out.push(Object.assign(clone(preset), {
        name: s && s.name ? s.name : preset.name,
        baseUrl: s && s.baseUrl ? s.baseUrl : preset.baseUrl,
        models: s && Array.isArray(s.models) && s.models.length ? clone(s.models) : clone(preset.models),
        preset: true
      }));
    }

    // Anything left over is a user-created provider.
    for (const s of byId.values()) {
      out.push({
        id: s.id,
        name: s.name || 'Custom provider',
        api: s.api === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: s.baseUrl || '',
        models: Array.isArray(s.models) ? clone(s.models) : [],
        defaultMaxTokens: s.defaultMaxTokens || 8192,
        noKeyNeeded: !!s.noKeyNeeded,
        preset: false
      });
    }

    return out;
  }

  function findProvider(providers, id) {
    return providers.find(p => p.id === id) || providers[0] || null;
  }

  function findModel(provider, modelId) {
    if (!provider) return null;
    const hit = (provider.models || []).find(m => m.id === modelId);
    if (hit) return hit;
    // Unknown / hand-typed model: assume nothing. Vision stays on so the
    // user can still paste images; reasoning params stay off so we never
    // 400 on a model whose capabilities we can't verify.
    return modelId
      ? { id: modelId, label: modelId, vision: true, thinking: null, effort: false, custom: true }
      : null;
  }

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
  }

  function newProviderId(existing, name) {
    const base = slugify(name);
    let id = base, n = 2;
    const taken = new Set(existing.map(p => p.id));
    while (taken.has(id)) id = base + '-' + (n++);
    return id;
  }

  root.scaiProviders = {
    PRESETS, EFFORTS, resolveProviders, findProvider, findModel, newProviderId, slugify, clone
  };
})(typeof window !== 'undefined' ? window : self);
