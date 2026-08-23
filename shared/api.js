/* ============================================================
   scAI — API client

   Speaks two dialects over plain fetch (no bundler in an extension,
   so no SDK):

   anthropic → POST {base}/messages
       headers: x-api-key, anthropic-version: 2023-06-01,
                anthropic-dangerous-direct-browser-access: true
       system is a top-level param; images are
         {type:'image', source:{type:'base64', media_type, data}}
       reasoning is thinking:{type:'adaptive'} + output_config.effort
       NOTE: temperature/top_p are rejected (400) on Opus 5 / Sonnet 5 /
       Opus 4.7+ — we never send them for this dialect.

   openai → POST {base}/chat/completions
       headers: Authorization: Bearer …
       system is messages[0]; images are
         {type:'image_url', image_url:{url:'data:…'}}

   Both stream Server-Sent Events; callers get onText / onThinking /
   onUsage callbacks and an AbortSignal to stop mid-stream.
   ============================================================ */
(function (root) {
  'use strict';

  const ANTHROPIC_VERSION = '2023-06-01';

  function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + path;
  }

  /* ---------------- content block builders ---------------- */

  // images: [{ mediaType, data (base64, no prefix) }]
  function anthropicContent(text, images) {
    if (!images || !images.length) return text;
    const blocks = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data }
    }));
    if (text) blocks.push({ type: 'text', text });
    return blocks;
  }

  function openaiContent(text, images) {
    if (!images || !images.length) return text;
    const blocks = images.map(img => ({
      type: 'image_url',
      image_url: { url: 'data:' + img.mediaType + ';base64,' + img.data }
    }));
    if (text) blocks.push({ type: 'text', text });
    return blocks;
  }

  /* ---------------- request builders ---------------- */

  function buildBody(opts) {
    const { provider, model, messages, system, settings } = opts;
    const anthropic = provider.api === 'anthropic';
    const maxTokens = Math.max(256, parseInt(settings.maxTokens, 10) || 8192);

    if (anthropic) {
      const body = {
        model: model.id,
        max_tokens: maxTokens,
        stream: true,
        messages: messages.map(m => ({
          role: m.role,
          content: anthropicContent(m.content, m.images)
        }))
      };
      if (system) body.system = system;

      if (settings.thinking === 'adaptive' && model.thinking === 'adaptive') {
        body.thinking = { type: 'adaptive', display: 'summarized' };
      } else if (settings.thinking === 'adaptive' && model.thinking === 'budget') {
        // Pre-4.6 models still take a fixed budget, which must be < max_tokens.
        body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxTokens / 2)) };
      }
      if (settings.effort && model.effort) {
        body.output_config = { effort: settings.effort };
      }
      // Deliberately no temperature: rejected by current Claude models.
      return body;
    }

    const msgs = messages.map(m => ({
      role: m.role,
      content: openaiContent(m.content, m.images)
    }));
    if (system) msgs.unshift({ role: 'system', content: system });

    const body = {
      model: model.id,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens
    };
    if (settings.sendTemperature && !model.reasoning) {
      body.temperature = Number(settings.temperature);
    }
    if (settings.effort && model.reasoning) {
      body.reasoning_effort = settings.effort === 'xhigh' ? 'high' : settings.effort;
    }
    return body;
  }

  function buildHeaders(provider, apiKey) {
    const h = { 'Content-Type': 'application/json' };
    if (provider.api === 'anthropic') {
      h['x-api-key'] = apiKey;
      h['anthropic-version'] = ANTHROPIC_VERSION;
      // Required for calls whose Origin is a browser context.
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (apiKey) {
      h['Authorization'] = 'Bearer ' + apiKey;
    }
    return h;
  }

  /* ---------------- error shaping ---------------- */

  function humanError(status, payload, provider) {
    const msg = (payload && (
      (payload.error && (payload.error.message || payload.error.type)) ||
      payload.message ||
      (typeof payload === 'string' ? payload : '')
    )) || '';

    if (status === 401 || status === 403) {
      return 'Authentication failed (' + status + '). Check the API key for ' + provider.name + ' in settings.'
        + (msg ? '\n\n' + msg : '');
    }
    if (status === 404) {
      return 'Not found (404). The model ID may not exist on ' + provider.name +
        ', or the base URL is wrong.' + (msg ? '\n\n' + msg : '');
    }
    if (status === 429) {
      return 'Rate limited (429) by ' + provider.name + '. Wait a moment and retry.' + (msg ? '\n\n' + msg : '');
    }
    if (status >= 500) {
      return provider.name + ' returned a server error (' + status + '). Retrying usually works.'
        + (msg ? '\n\n' + msg : '');
    }
    return msg ? 'Request failed (' + status + '): ' + msg : 'Request failed (' + status + ').';
  }

  /**
   * Some OpenAI-compatible endpoints reject params others require.
   * Rewrite the body once based on what the server complained about.
   * Returns a new body, or null when there's nothing worth retrying.
   */
  function adaptBody(body, message) {
    const m = String(message || '').toLowerCase();
    const next = Object.assign({}, body);
    let changed = false;

    if (m.includes('max_completion_tokens') && 'max_tokens' in next) {
      next.max_completion_tokens = next.max_tokens;
      delete next.max_tokens;
      changed = true;
    }
    if (m.includes('temperature') && 'temperature' in next) {
      delete next.temperature;
      changed = true;
    }
    if (m.includes('reasoning_effort') && 'reasoning_effort' in next) {
      delete next.reasoning_effort;
      changed = true;
    }
    if (m.includes('stream_options') && 'stream_options' in next) {
      delete next.stream_options;
      changed = true;
    }
    return changed ? next : null;
  }

  /* ---------------- SSE plumbing ---------------- */

  async function* sseLines(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  }

  function handleAnthropicEvent(evt, cb) {
    switch (evt.type) {
      case 'content_block_delta': {
        const d = evt.delta || {};
        if (d.type === 'text_delta' && d.text) cb.onText(d.text);
        else if (d.type === 'thinking_delta' && d.thinking) cb.onThinking(d.thinking);
        break;
      }
      case 'message_start':
        if (evt.message && evt.message.usage) cb.onUsage(evt.message.usage);
        break;
      case 'message_delta':
        if (evt.usage) cb.onUsage(evt.usage);
        if (evt.delta && evt.delta.stop_reason) cb.onStop(evt.delta.stop_reason);
        break;
      case 'error':
        throw new Error((evt.error && evt.error.message) || 'Stream error');
      default:
        break;
    }
  }

  function handleOpenAIEvent(evt, cb) {
    if (evt.error) throw new Error(evt.error.message || 'Stream error');
    if (evt.usage) {
      cb.onUsage({
        input_tokens: evt.usage.prompt_tokens,
        output_tokens: evt.usage.completion_tokens
      });
    }
    const choice = (evt.choices || [])[0];
    if (!choice) return;
    const d = choice.delta || {};
    // Reasoning traces travel under different names across vendors.
    const reason = d.reasoning_content || d.reasoning;
    if (reason) cb.onThinking(reason);
    if (typeof d.content === 'string' && d.content) cb.onText(d.content);
    else if (Array.isArray(d.content)) {
      for (const part of d.content) {
        if (part && part.type === 'text' && part.text) cb.onText(part.text);
      }
    }
    if (choice.finish_reason) cb.onStop(choice.finish_reason);
  }

  /* ---------------- public: streaming completion ---------------- */

  /**
   * @param {object} opts
   *   provider, model, messages, system, settings, apiKey, signal
   *   onText(str), onThinking(str), onUsage(obj), onStop(reason)
   * @returns {Promise<{text, thinking, usage, stopReason}>}
   */
  async function complete(opts) {
    const { provider, apiKey, signal } = opts;
    const url = joinUrl(provider.baseUrl, provider.api === 'anthropic' ? '/messages' : '/chat/completions');
    const headers = buildHeaders(provider, apiKey);
    let body = buildBody(opts);

    const cb = {
      onText: opts.onText || function () {},
      onThinking: opts.onThinking || function () {},
      onUsage: opts.onUsage || function () {},
      onStop: opts.onStop || function () {}
    };

    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new Error(
          'Could not reach ' + provider.name + ' at ' + provider.baseUrl + '.\n\n' +
          'Check the base URL and your connection. For a local server (Ollama, LM Studio) make ' +
          'sure it is running and allows requests from browser extensions.'
        );
      }

      if (response.ok) break;

      const raw = await response.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch (e) { payload = raw; }

      const msg = (payload && payload.error && payload.error.message) || String(raw || '');
      const retryBody = (attempt === 0 && response.status === 400 && provider.api === 'openai')
        ? adaptBody(body, msg)
        : null;

      if (retryBody) { body = retryBody; continue; }
      throw new Error(humanError(response.status, payload, provider));
    }

    if (!response.body) throw new Error('This endpoint returned no streaming body.');

    let text = '', thinking = '', usage = null, stopReason = null;
    const sink = {
      onText: t => { text += t; cb.onText(t); },
      onThinking: t => { thinking += t; cb.onThinking(t); },
      onUsage: u => {
        usage = Object.assign({}, usage, u);
        cb.onUsage(usage);
      },
      onStop: r => { stopReason = r; cb.onStop(r); }
    };

    for await (const line of sseLines(response)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch (e) { continue; }
      if (provider.api === 'anthropic') handleAnthropicEvent(evt, sink);
      else handleOpenAIEvent(evt, sink);
    }

    return { text, thinking, usage, stopReason };
  }

  /* ---------------- public: model discovery ---------------- */

  async function listModels(provider, apiKey) {
    const url = joinUrl(provider.baseUrl, '/models');
    const res = await fetch(url, { headers: buildHeaders(provider, apiKey) });
    if (!res.ok) {
      const raw = await res.text();
      let payload; try { payload = JSON.parse(raw); } catch (e) { payload = raw; }
      throw new Error(humanError(res.status, payload, provider));
    }
    const json = await res.json();
    const rows = json.data || json.models || [];
    return rows
      .map(m => ({
        id: m.id || m.name,
        label: m.display_name || m.name || m.id,
        vision: true
      }))
      .filter(m => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  root.scaiApi = { complete, listModels, ANTHROPIC_VERSION };
})(typeof window !== 'undefined' ? window : self);
