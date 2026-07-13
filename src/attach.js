// File attachments for a user message. Two classes, handled differently at send:
//   · text-ish (.md, .txt, code, json…) → contents inlined into the prompt as
//     text, so any model (incl. a text-only local Qwen) can read them.
//   · image (.png, .jpg, .webp, .gif) → attached as an OpenAI-protocol
//     `image_url` content part with a base64 data: URL. Needs a vision model;
//     if the server rejects it we surface a clean "no vision" error (openai.js).
//
// Trigger: `@path` tokens in the input (a drag-drop onto the terminal pastes the
// file's path, so it flows through the same detector). Paths may be quoted, use
// ~, or be relative to the shell cwd. Non-file `@mentions` are left untouched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shellState } from './tools/shell.js';

const IMAGE_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

// Extensions we KNOW are binary/non-text — never inline these as text (an image
// that isn't a supported vision format, an archive, a pdf we can't render, etc.).
const BINARY_EXT = new Set([
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar', '.mp3', '.wav', '.flac',
  '.mp4', '.mov', '.avi', '.mkv', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.ico', '.tiff', '.heic',
]);

// Inlined-text budget: keep a big file from blowing the context. Head+tail like
// shell output, with a marker naming the file so the model can read the rest.
const TEXT_LIMIT = 64 * 1024;   // ~64KB of file text inlined
const IMAGE_LIMIT = 20 * 1024 * 1024; // 20MB base64 sanity cap

// Pull `@path` tokens out of a line. Supports `@"quoted path"`, `@'…'`, and bare
// `@path/with/no/spaces`. Returns [{ raw, rawToken, spec }] where rawToken is the
// exact substring to strip from the text and spec is the resolved-ish path.
function findMentions(text) {
  const out = [];
  const re = /@(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3] ?? '';
    if (!spec) continue;
    out.push({ rawToken: m[0], spec });
  }
  return out;
}

// Resolve a mention spec to an absolute path: honor ~, and resolve relatives
// against the live shell cwd (so `@notes.md` works wherever the model cd'd to).
function resolvePath(spec, cwd) {
  let p = spec;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) p = path.resolve(cwd || shellState.cwd || process.cwd(), p);
  return p;
}

// Heuristic: is this file text? Known image/binary ext → no. Otherwise sniff the
// first chunk for NUL bytes / a high ratio of non-printable bytes.
function looksTextual(abs, ext) {
  if (IMAGE_EXT[ext] || BINARY_EXT.has(ext)) return false;
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (n === 0) return true; // empty file — treat as text
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (b === 0) return false; // NUL → binary
      // allow tab/newline/carriage-return + printable range
      if (b < 9 || (b > 13 && b < 32)) suspicious++;
    }
    return suspicious / n < 0.15;
  } catch {
    return false;
  }
}

function clampText(s, file) {
  if (s.length <= TEXT_LIMIT) return s;
  const half = Math.floor(TEXT_LIMIT / 2);
  const omitted = s.length - TEXT_LIMIT;
  return `${s.slice(0, half)}\n\n… [${omitted} bytes omitted — read ${file} for the full file] …\n\n${s.slice(-half)}`;
}

// Build the OpenAI-protocol content parts for a user turn from raw input text.
// Returns:
//   { text, parts, attachments, notes }
//   · text        — the input with resolved @tokens stripped (what shows in the UI)
//   · parts       — OpenAI content array [{type:'text',...}, {type:'image_url',...}]
//                   ONLY when there's ≥1 image; otherwise null (send plain text).
//   · attachments — [{ spec, abs, kind:'text'|'image'|'missing'|'binary', bytes }]
//                   for UI chips + notices.
//   · notes       — human-readable strings for anything skipped (missing/binary).
//
// Text files are INLINED into the leading text part. Images become image_url
// parts. If nothing resolved to a real file, parts is null and text is unchanged.
export function buildUserContent(rawText, { cwd } = {}) {
  const mentions = findMentions(rawText);
  const attachments = [];
  const notes = [];
  let text = rawText;
  const inlinedBlocks = [];
  const imageParts = [];

  for (const { rawToken, spec } of mentions) {
    const abs = resolvePath(spec, cwd);
    let st;
    try { st = fs.statSync(abs); } catch { st = null; }

    if (!st || !st.isFile()) {
      // not a real file — leave the @mention in the text untouched (could be a
      // username, a decorator, an @-handle the user meant literally).
      attachments.push({ spec, abs, kind: 'missing' });
      continue;
    }

    const ext = path.extname(abs).toLowerCase();

    if (IMAGE_EXT[ext]) {
      try {
        const buf = fs.readFileSync(abs);
        if (buf.length > IMAGE_LIMIT) {
          notes.push(`${path.basename(abs)} is too large to attach (${(buf.length / 1e6).toFixed(1)}MB > 20MB)`);
          attachments.push({ spec, abs, kind: 'binary', bytes: buf.length });
        } else {
          const url = `data:${IMAGE_EXT[ext]};base64,${buf.toString('base64')}`;
          imageParts.push({ type: 'image_url', image_url: { url } });
          attachments.push({ spec, abs, kind: 'image', bytes: buf.length });
          text = text.replace(rawToken, '').replace(/\s{2,}/g, ' ').trim();
        }
      } catch (err) {
        notes.push(`couldn't read ${path.basename(abs)}: ${err.message}`);
        attachments.push({ spec, abs, kind: 'missing' });
      }
      continue;
    }

    if (looksTextual(abs, ext)) {
      try {
        const body = clampText(fs.readFileSync(abs, 'utf8'), abs);
        inlinedBlocks.push(`--- ${abs} ---\n${body}`);
        attachments.push({ spec, abs, kind: 'text', bytes: st.size });
        text = text.replace(rawToken, '').replace(/\s{2,}/g, ' ').trim();
      } catch (err) {
        notes.push(`couldn't read ${path.basename(abs)}: ${err.message}`);
        attachments.push({ spec, abs, kind: 'missing' });
      }
      continue;
    }

    // real file, but binary and not a supported image
    notes.push(`${path.basename(abs)} isn't a text or image file — skipped`);
    attachments.push({ spec, abs, kind: 'binary', bytes: st.size });
  }

  // Compose the leading text: inlined file blocks first (so they're context),
  // then the user's own words.
  const leadText = [inlinedBlocks.join('\n\n'), text].filter(Boolean).join('\n\n');

  // Only emit a parts ARRAY when there's an image (multimodal). Text-only
  // attachments just fold into the string — every model handles that.
  if (imageParts.length > 0) {
    const parts = [];
    if (leadText) parts.push({ type: 'text', text: leadText });
    parts.push(...imageParts);
    return { text: leadText, parts, attachments, notes };
  }

  return { text: leadText, parts: null, attachments, notes };
}

// Does this input contain at least one @token that resolves to a real file?
// Cheap check for the UI to decide whether to route through buildUserContent.
export function hasAttachment(rawText, cwd) {
  for (const { spec } of findMentions(rawText)) {
    const abs = resolvePath(spec, cwd);
    try { if (fs.statSync(abs).isFile()) return true; } catch { /* not a file */ }
  }
  return false;
}
