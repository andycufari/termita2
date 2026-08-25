// Find the files a message TALKS ABOUT, so they can be opened without retyping
// the path.
//
// The model names files constantly — `PRODUCT.md`, src/ui/pane.jsx, a full
// absolute path — and the Markdown renderer already parses those spans just to
// colour them. This reads the same text and keeps the ones that are plausibly
// real files, so `/view` with no argument can offer a list instead of demanding
// a path.
//
// The bar here is deliberately "plausible, then verified against disk": a
// regex alone can't tell `npm run build` from `src/app.jsx`, so we filter hard
// on shape and then stat the survivors. Anything that doesn't exist is dropped
// rather than offered — a picker full of dead entries is worse than no picker.
import fs from 'node:fs';
import path from 'node:path';
import { shellState } from '../tools/shell.js';

// Inline code spans are the strongest signal (the model backticks filenames),
// but it also writes them bare, so we sweep three ways and dedupe.
const CODE = /`([^`\n]+)`/g;
// A bare path: at least one slash, ending in an extension. The `~/` and `./`
// prefixes are part of the FIRST segment, not a separate optional group — as a
// separate group they had to be followed by a word character, so `~/notes/x.md`
// (where `/` follows `~` immediately) never matched.
const BARE = /(?:^|[\s(["'])((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.\w{1,6})/g;
// A bare DIRECTORY, written with a trailing slash (src/ui/, ~/DEUS/maki/). The
// trailing slash is what distinguishes it from prose; without it we'd be
// guessing at every bare word.
const DIR = /(?:^|[\s(["'])((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\/)(?=[\s,.;:)\]"']|$)/g;
// A bare filename with a known extension and no slash at all (README.md).
// Restricted to an extension list on purpose: without a slash, `foo.bar` is far
// more likely to be prose or a version than a file.
const LOOSE = /(?:^|[\s(["'])([\w.+-]+\.(?:md|markdown|txt|json|ya?ml|toml|jsx?|tsx?|mjs|cjs|py|sh|bash|zsh|rs|go|c|h|cpp|java|rb|php|css|scss|html?|xml|ini|conf|cfg|env|sql|csv|log|lock))(?=[\s,.;:)\]"']|$)/gi;

// The model writes "PRODUCT.md § Por qué existe" or "config.json: the ui key" —
// the file is the head, the rest is a pointer INTO it. Keep the head.
function clean(s) {
  let t = String(s).trim();
  t = t.split(/\s+[§#]|\s+—|\s+-\s|\s*:\s/)[0].trim();
  // Keep a trailing slash: it's what marks a directory. Everything else that
  // trails (punctuation, quotes) is prose, not part of the name.
  const dir = t.endsWith('/');
  t = t.replace(/^[("'`\[]+|[)"'`,.;\]]+$/g, '');
  if (dir && !t.endsWith('/')) t += '/';
  return t;
}

function looksLikePath(s) {
  if (!s || s.length > 250) return false;
  if (/\s/.test(s)) return false;        // whitespace → almost certainly a phrase or a command
  if (/^[-$]/.test(s)) return false;     // --flag, $VAR
  if (!/[/.]/.test(s)) return false;     // needs a slash or a dot to be a path at all
  if (/^\d+(\.\d+)+$/.test(s)) return false; // 3.2, 1.0.4 — a version, not a file
  return /\.\w{1,6}$/.test(s) || s.includes('/');
}

// Extract candidates from one blob of text, in order of first appearance.
export function extractMentions(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const c = clean(raw);
    if (!looksLikePath(c) || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  for (const m of String(text).matchAll(CODE)) add(m[1]);
  for (const m of String(text).matchAll(BARE)) add(m[1]);
  for (const m of String(text).matchAll(DIR)) add(m[1]);
  for (const m of String(text).matchAll(LOOSE)) add(m[1]);
  return out;
}

function resolve(p) {
  let s = p;
  if (s.startsWith('~')) s = s.replace(/^~/, process.env.HOME || '');
  return path.isAbsolute(s) ? s : path.resolve(shellState.cwd || process.cwd(), s);
}

// Walk the transcript newest-first and return the files that actually EXIST,
// newest mention first — what was just discussed is what you most likely want
// to open. `limit` keeps the picker to one screen.
export function fileMentions(items, limit = 12) {
  const out = [];
  const seen = new Set();
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const it = items[i];
    // Assistant prose only. User messages are already the user's own words, and
    // tool cards/output would flood this with every path a command ever printed.
    if (it?.kind !== 'msg' || it.who !== 'term' || !it.text) continue;
    for (const cand of extractMentions(it.text)) {
      if (out.length >= limit) break;
      const full = resolve(cand);
      if (seen.has(full)) continue;
      seen.add(full);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; } // doesn't exist → not offered
      out.push({
        label: cand,                       // as the model wrote it — recognisable
        path: full,
        dir: stat.isDirectory(),
        size: stat.isDirectory() ? null : stat.size,
      });
    }
  }
  return out;
}

export default fileMentions;
