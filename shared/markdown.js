/* ============================================================
   scAI — minimal markdown renderer

   Builds real DOM nodes instead of assembling an HTML string, so
   model output can never be injected as markup. Supports fenced
   code (with a copy button), ATX headings, unordered/ordered lists,
   blockquotes, horizontal rules, tables, and inline code / bold /
   italic / strikethrough / links / autolinks.
   ============================================================ */
(function (root) {
  'use strict';

  const INLINE = new RegExp([
    '(`+)([\\s\\S]+?)\\1',                 // 1,2 inline code
    '\\*\\*([\\s\\S]+?)\\*\\*',            // 3 bold
    '__([\\s\\S]+?)__',                    // 4 bold
    '(?<![\\w*])\\*([^*\\n]+?)\\*(?![\\w*])', // 5 italic
    '(?<![\\w_])_([^_\\n]+?)_(?![\\w_])',  // 6 italic
    '~~([\\s\\S]+?)~~',                    // 7 strike
    '\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)',// 8,9 link
    '(https?:\\/\\/[^\\s<>"\'`\\)\\]]+)'   // 10 autolink
  ].join('|'), 'g');

  function safeHref(url) {
    try {
      const u = new URL(url, 'https://example.invalid');
      return (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') ? url : null;
    } catch (e) { return null; }
  }

  function link(href, label) {
    const safe = safeHref(href);
    if (!safe) return document.createTextNode(label || href);
    const a = document.createElement('a');
    a.href = safe;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label || href;
    return a;
  }

  function inline(text, parent) {
    // A fresh matcher per call: bold/italic/strike recurse into inline(),
    // and a shared /g regex would have its lastIndex clobbered mid-loop.
    const re = new RegExp(INLINE.source, 'g');
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      last = m.index + m[0].length;
      if (!m[0].length) { re.lastIndex++; continue; }

      if (m[2] !== undefined) {
        const c = document.createElement('code');
        c.textContent = m[2];
        parent.appendChild(c);
      } else if (m[3] !== undefined || m[4] !== undefined) {
        const s = document.createElement('strong');
        inline(m[3] !== undefined ? m[3] : m[4], s);
        parent.appendChild(s);
      } else if (m[5] !== undefined || m[6] !== undefined) {
        const e = document.createElement('em');
        inline(m[5] !== undefined ? m[5] : m[6], e);
        parent.appendChild(e);
      } else if (m[7] !== undefined) {
        const d = document.createElement('del');
        inline(m[7], d);
        parent.appendChild(d);
      } else if (m[9] !== undefined) {
        parent.appendChild(link(m[9], m[8]));
      } else if (m[10] !== undefined) {
        parent.appendChild(link(m[10], m[10]));
      }
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function codeBlock(code, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'md-code';

    const bar = document.createElement('div');
    bar.className = 'md-code-bar';

    const tag = document.createElement('span');
    tag.className = 'md-code-lang';
    tag.textContent = lang || 'code';
    bar.appendChild(tag);

    const copy = document.createElement('button');
    copy.className = 'md-code-copy';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });
    });
    bar.appendChild(copy);

    const pre = document.createElement('pre');
    const el = document.createElement('code');
    el.textContent = code;
    pre.appendChild(el);

    wrap.appendChild(bar);
    wrap.appendChild(pre);
    return wrap;
  }

  function splitRow(line) {
    return line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map(c => c.trim());
  }

  function render(text, container) {
    container.textContent = '';
    const lines = String(text == null ? '' : text).split('\n');
    let i = 0;
    let para = [];

    function flushPara() {
      if (!para.length) return;
      const p = document.createElement('p');
      inline(para.join('\n'), p);
      container.appendChild(p);
      para = [];
    }

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
      if (fence) {
        flushPara();
        const marker = fence[1][0];
        const body = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
          body.push(lines[i]); i++;
        }
        i++; // closing fence
        container.appendChild(codeBlock(body.join('\n'), fence[2]));
        continue;
      }

      // horizontal rule
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        flushPara();
        container.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      // heading
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const el = document.createElement('h' + Math.min(6, h[1].length + 2));
        inline(h[2].replace(/\s+#+\s*$/, ''), el);
        container.appendChild(el);
        i++;
        continue;
      }

      // table
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushPara();
        const table = document.createElement('table');
        table.className = 'md-table';
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const cell of splitRow(line)) {
          const th = document.createElement('th');
          inline(cell, th);
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);
        i += 2;
        const tbody = document.createElement('tbody');
        while (i < lines.length && /\S/.test(lines[i]) && lines[i].includes('|')) {
          const tr = document.createElement('tr');
          for (const cell of splitRow(lines[i])) {
            const td = document.createElement('td');
            inline(cell, td);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        container.appendChild(table);
        continue;
      }

      // blockquote
      if (/^\s{0,3}>\s?/.test(line)) {
        flushPara();
        const body = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++;
        }
        const bq = document.createElement('blockquote');
        render(body.join('\n'), bq);
        container.appendChild(bq);
        continue;
      }

      // lists (one level of nesting)
      const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        const ordered = /\d/.test(li[2]);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'md-list';
        while (i < lines.length) {
          const row = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
          if (!row) {
            // continuation line of the current item
            if (/^\s+\S/.test(lines[i]) && list.lastChild) {
              list.lastChild.appendChild(document.createTextNode('\n' + lines[i].trim()));
              i++;
              continue;
            }
            break;
          }
          if (/\d/.test(row[2]) !== ordered && row[1].length === 0) break;
          const item = document.createElement('li');
          const chk = row[3].match(/^\[([ xX])\]\s+(.*)$/);
          if (chk) {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.disabled = true;
            box.checked = chk[1].toLowerCase() === 'x';
            box.className = 'md-check';
            item.appendChild(box);
            inline(chk[2], item);
          } else {
            inline(row[3], item);
          }
          list.appendChild(item);
          i++;
        }
        container.appendChild(list);
        continue;
      }

      if (!line.trim()) { flushPara(); i++; continue; }

      para.push(line);
      i++;
    }
    flushPara();
    return container;
  }

  root.scaiMarkdown = { render };
})(typeof window !== 'undefined' ? window : self);
