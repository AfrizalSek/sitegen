// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site 1.0.0's build, byte for byte, on every input.
// Rewritten for speed: chunked HTML escaping (no per-character replace),
// fused Markdown lex+render (no token objects), cached slugs/dates/links,
// scan-based word counting, and an array-output template renderer.
// Every cache lives inside one run() call: nothing is kept from one case
// to the next. No dependencies, no I/O, no clock, no randomness.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (chunked: one replace per run). */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDateSlow(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
/** Words: runs of non-whitespace, counted by a scan (no regex match array). */
function wordsCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x3001 ? WS_T[c] === 1 : c === 0xfeff) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function longDate(date, C) {
  let v = C.date.get(date);
  if (v === undefined) { v = longDateSlow(date); C.date.set(date, v); }
  return v;
}

/** The slow (exact baseline) slug path, for strings with non-ASCII in them. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, cached per run; ASCII strings take a fast char-code path. */
function slugify(text, C) {
  const cached = C.slug.get(text);
  if (cached !== undefined) return cached;
  let out;
  if (!/[^\x00-\x7F]/.test(text)) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    out = slugifySlow(text);
  }
  C.slug.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whitespace table (JS \s) for char codes under 0x3001; 0xfeff handled separately. */
const WS_T = new Uint8Array(0x3001);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]) WS_T[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_T[c] = 1;
const isWsCode = (c) => (c < 0x3001 ? WS_T[c] === 1 : c === 0xfeff);

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body, or { error }. Scans lines by indexOf so
 * the (usually large) body is never split into lines here.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  // Find the closing line first: a malformed line before it still loses to
  // "not closed", exactly as the reference does.
  let closeIdx = -1;
  let closeEnd = -1;
  {
    let p = nl0 === -1 ? text.length : nl0 + 1;
    let i = 1;
    while (p <= text.length) {
      const e = text.indexOf('\n', p);
      const line = e === -1 ? text.slice(p) : text.slice(p, e);
      if (line === '---') { closeIdx = i; closeEnd = e; break; }
      if (e === -1) break;
      p = e + 1;
      i++;
    }
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  {
    let p = nl0 + 1;
    for (let i = 1; i < closeIdx; i++) {
      const e = text.indexOf('\n', p);
      const line = e === -1 ? text.slice(p) : text.slice(p, e);
      if (/^[ \t]*$/.test(line) || line.startsWith('#')) { p = e + 1; continue; }
      const m = LINE.exec(line);
      if (!m) return { error: `line ${i + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
      p = e + 1;
    }
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------------ markdown

const ESC_T = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESC_T[ch.charCodeAt(0)] = 1;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS_RE = /\s/;

/** A line of spaces/tabs only (or empty). */
function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
function trimEndST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}
function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45;
}
/** Fence opener: ``` + optional language, then spaces/tabs only; returns lang or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  const lang = line.slice(3, k);
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k === line.length ? lang : null;
}
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let k = 3;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k === line.length;
}
/** Heading: { depth, text } or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h > 6 || h === line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let t = h;
  while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
  if (t === line.length) return null;
  const text = trimEndST(line.slice(t));
  return text === '' ? null : { depth: h, text };
}
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  let k = 3;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k === line.length;
}
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWsCode(line.charCodeAt(k));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESC_T[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const code = s.charCodeAt(j);
    if (code === 92 && j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESC_T[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (code !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*[]/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env, C) {
  if (!INLINE_SPECIAL.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0;
  let plain = 0;
  const flush = (to) => { if (to > plain) out.push(escapeHtml(s.slice(plain, to))); };
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 92 && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ESC_T[s.charCodeAt(i + 1)] === 1) {
      flush(i);
      const ch = s[i + 1];
      out.push(ch === '>' ? '&gt;' : ch);
      i += 2;
      plain = i;
      continue;
    }
    if (code === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (code === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>', inline(s.slice(i + 2, j), env, C), '</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>', inline(s.slice(i + 1, j), env, C), '</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env, C), '</a>');
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out.join('');
}

/**
 * `src` rendered, fused lex+render: its HTML, its table of contents and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, C) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const code = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, C), ids);
      const html = inline(heading.text, env, C);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) { const t = trimST(l); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env, C)}</p>\n</blockquote>`);
      continue;
    }
    // List: bullet "- "/"* " or ordered "digits. "
    let isOrdered = false;
    let start = 1;
    let itemText = null;
    {
      const c0 = line.charCodeAt(0);
      if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) itemText = line.slice(2);
      else if (c0 >= 48 && c0 <= 57) {
        let d = 0;
        while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
        if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
          isOrdered = true;
          start = Number(line.slice(0, d));
          itemText = line.slice(d + 2);
        }
      }
    }
    if (itemText !== null) {
      const items = [[trimST(itemText)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let mText = null;
        let mOrdered = false;
        let mStart = 1;
        if (isOrdered) {
          const c0 = l.charCodeAt(0);
          if (c0 >= 48 && c0 <= 57) {
            let d = 0;
            while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
            if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
              mOrdered = true;
              mStart = Number(l.slice(0, d));
              mText = l.slice(d + 2);
            }
          }
        } else {
          const c0 = l.charCodeAt(0);
          if ((c0 === 45 || c0 === 42) && l.charCodeAt(1) === 32) mText = l.slice(2);
        }
        if (mText !== null) {
          // A marker of the other kind ends the list; the first item's kind rules.
          if (mOrdered !== isOrdered) break;
          items.push([trimST(mText)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const item of items) list += `<li>${inline(item.join('\n'), env, C)}</li>\n`;
      blocks.push(`${list}</${tag}>`);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), env, C);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Render `nodes` into `out` (an array of chunks, joined by the caller). */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope for this loop's iterations (fresh per entry into the
        // node, so a recursive include re-entering it gets its own).
        const vars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars.loop = loop;
        const sub = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, sub, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // Memoize the include when its result is fixed by the values it reads:
        // its transitive dependencies are all shared objects of this case
        // (site/tags/recent, the posts array, a post's card) or constants.
        // A fresh per-render object (a page, a tag, a pager) never memoizes,
        // so the cache only ever holds renders that really repeat.
        const deps = ctx.deps.get(n.name);
        const key = deps === undefined ? null : memoKey(scope, deps, ctx.C);
        if (key === null) {
          renderNodes(t, scope, ctx, depth + 1, out);
          break;
        }
        const ck = n.name + '\x00' + depth + '\x00' + key;
        const hit = ctx.incCache.get(ck);
        if (hit !== undefined) { out.push(hit); break; }
        const sub = [];
        renderNodes(t, scope, ctx, depth + 1, sub);
        const s = sub.join('');
        ctx.incCache.set(ck, s);
        out.push(s);
        break;
      }
    }
  }
}

/** First-name lookup (single-segment path). */
function lookup1(scope, name) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/**
 * Cache key for an include's dependencies in `scope`, or null when it must
 * not be memoized (a dependency is a fresh per-render object, a long string,
 * or anything else whose identity is not shared for this case).
 */
function memoKey(scope, deps, C) {
  let key = '';
  for (const d of deps) {
    const v = lookup1(scope, d);
    if (v === undefined) key += 'u;';
    else if (v === null) key += 'z;';
    else if (typeof v === 'object') {
      if (!C.shared.has(v)) return null;
      let id = C.objIds.get(v);
      if (id === undefined) { id = ++C.objSeq; C.objIds.set(v, id); }
      key += 'o' + id + ';';
    } else if (typeof v === 'string') {
      if (v.length > 64) return null;
      key += 's' + JSON.stringify(v) + ';';
    } else if (typeof v === 'number' || typeof v === 'boolean') key += 'n' + String(v) + ';';
    else return null;
  }
  return key;
}

/**
 * Every template's transitive dependency names: the first names its nodes
 * read (through its includes), minus names its own `for` loops bind.
 * Computed by fixed point, so include cycles are handled.
 */
function computeDeps(templates) {
  const direct = new Map();
  const includes = new Map();
  const walk = (nodes, bound, deps, incs) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
        walk(n.then, bound, deps, incs);
        if (n.else !== null) walk(n.else, bound, deps, incs);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) deps.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2, deps, incs);
      } else if (n.kind === 'include') incs.add(n.name);
    }
  };
  for (const [name, nodes] of templates) {
    const deps = new Set();
    const incs = new Set();
    walk(nodes, new Set(), deps, incs);
    direct.set(name, deps);
    includes.set(name, incs);
  }
  const out = new Map();
  for (const [name, deps] of direct) out.set(name, new Set(deps));
  for (let round = 0; round < 40; round++) {
    let changed = false;
    for (const [name, incs] of includes) {
      const deps = out.get(name);
      for (const inc of incs) {
        const sub = out.get(inc);
        if (sub === undefined) continue;
        for (const d of sub) if (!deps.has(d)) { deps.add(d); changed = true; }
      }
    }
    if (!changed) break;
  }
  const arr = new Map();
  for (const [name, deps] of out) arr.set(name, [...deps]);
  return arr;
}

// ------------------------------------------------------------------ build

const linkOf = (s, C) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, C) });

function cardOf(s, C) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, C),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsCount(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, C, cardOfS) {
  return {
    ...cardOfS(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, C),
    older: linkOf(s.older ?? null, C),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. Exactly makefun-site 1.0.0's answer. */
export function run(input) {
  const C = { slug: new Map(), date: new Map(), link: new Map(), shared: new WeakSet(), objIds: new Map(), objSeq: 0 };
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, sorted by path; .md sources have \r\n / \r made \n, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the reference's check order.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
      if (s.post && !hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
      s.layout = layout;
      if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
      kept.push(s);
    }
    sources = kept;
  }

  // Permalinks: slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, C), set);
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        let inner = C.link.get(dir);
        const hit = inner === undefined ? undefined : inner.get(target);
        if (hit !== undefined) {
          if (hit === null) { broken.add(`broken-link ${s.path} -> ${target}`); return target; }
          return hit;
        }
        if (inner === undefined) { inner = new Map(); C.link.set(dir, inner); }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) {
          const href = bySource.get(path).url + frag;
          inner.set(target, href);
          return href;
        }
        if (path !== null && staticPaths.has(path)) {
          const href = `${base}/${path}${frag}`;
          inner.set(target, href);
          return href;
        }
        inner.set(target, null);
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, C);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name, C);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, C);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, C)) ?? { name, slug: slugify(name, C), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const output = {};
  const cardCache = new Map();
  const cardOfS = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) { c = cardOf(s, C); cardCache.set(s, c); C.shared.add(c); }
    return c;
  };
  const site = { title: input.site.title, base_url: base };
  C.shared.add(site);
  C.shared.add(posts);
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOfS(p));
  C.shared.add(allTags);
  C.shared.add(recent);
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates, escape: escapeHtml, deps: computeDeps(templates), incCache: new Map(), C };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, C, cardOfS) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOfS(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOfS(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
