/* ============================================================
   scAI — page reader

   Injected on demand (never a persistent content script) by
   tabs.executeScript. Returns a compact, readable snapshot of the
   page plus whatever the user has highlighted. executeScript hands
   back the value of this file's last expression — the IIFE call —
   so the result object must be RETURNED, not merely evaluated.
   ============================================================ */
(function () {
  'use strict';

  const STRIP = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'nav', 'footer', 'aside', 'form', 'button', 'select',
    '[aria-hidden="true"]', '[hidden]', '[role="navigation"]',
    '[role="banner"]', '[role="complementary"]', '[role="search"]'
  ].join(',');

  function pickRoot() {
    const candidates = [
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('#content, .content, #main, .main, .post, .article-body')
    ].filter(Boolean);

    let best = null, bestLen = 0;
    for (const c of candidates) {
      const len = (c.innerText || '').trim().length;
      if (len > bestLen) { best = c; bestLen = len; }
    }
    const bodyLen = ((document.body && document.body.innerText) || '').trim().length;
    // Only trust a container if it holds a meaningful share of the page.
    return (best && bestLen > 400 && bestLen > bodyLen * 0.25) ? best : document.body;
  }

  function readable(root) {
    if (!root) return '';
    let clone;
    try {
      clone = root.cloneNode(true);
    } catch (e) {
      return (root.innerText || '').trim();
    }
    clone.querySelectorAll(STRIP).forEach(n => n.remove());
    // innerText on a detached node loses layout-based line breaks, so
    // re-introduce them around block elements before reading textContent.
    clone.querySelectorAll('p,div,section,li,tr,h1,h2,h3,h4,h5,h6,br,pre,blockquote')
      .forEach(n => n.appendChild(document.createTextNode('\n')));
    return (clone.textContent || '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function meta(name) {
    const el = document.querySelector(
      'meta[name="' + name + '"], meta[property="og:' + name + '"], meta[property="' + name + '"]'
    );
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function headings() {
    return Array.from(document.querySelectorAll('h1,h2,h3'))
      .slice(0, 25)
      .map(h => '  '.repeat(Math.max(0, parseInt(h.tagName[1], 10) - 1)) + (h.innerText || '').trim())
      .filter(t => t.trim())
      .join('\n');
  }

  let selection = '';
  try {
    const sel = window.getSelection();
    selection = sel ? String(sel).replace(/\s+\n/g, '\n').trim() : '';
  } catch (e) { selection = ''; }

  function everything() {
    // The raw, unfiltered text of the whole document — nav, footers and all.
    // innerText keeps CSS visibility rules in play, which is what a reader sees.
    const root = document.body || document.documentElement;
    if (!root) return '';
    return ((root.innerText || root.textContent || '') + '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return {
    ok: true,
    url: location.href,
    title: document.title || '',
    description: meta('description'),
    outline: headings(),
    selection: selection,
    text: readable(pickRoot()),
    fullText: everything()
  };
})();
