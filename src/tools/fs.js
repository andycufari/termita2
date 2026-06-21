// FS tools: read / write / grep. read+grep are read-only (auto-run); write mutates.
import fs from 'node:fs';
import path from 'node:path';
import { shellState } from './shell.js';

function resolvePath(p) {
  if (!p) return process.cwd();
  if (p.startsWith('~')) p = p.replace(/^~/, process.env.HOME || '');
  return path.isAbsolute(p) ? p : path.resolve(shellState.cwd || process.cwd(), p);
}

export function readFile(p, range) {
  const full = resolvePath(p);
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(full, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort();
      return { output: entries.join('\n') || '(empty dir)', meta: { dir: true } };
    }
    let content = fs.readFileSync(full, 'utf8');
    if (range) {
      const m = range.match(/(\d+)\s*-\s*(\d+)/);
      if (m) {
        const lines = content.split('\n');
        const a = Math.max(1, parseInt(m[1], 10));
        const b = Math.min(lines.length, parseInt(m[2], 10));
        content = lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n');
      }
    }
    return { output: content || '(empty file)', meta: { path: full } };
  } catch (err) {
    return { output: `error: ${err.message}`, meta: { error: true } };
  }
}

export function writeFile(p, content, ctx = {}) {
  const full = resolvePath(p);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? '', 'utf8');
    const bytes = Buffer.byteLength(content ?? '', 'utf8');
    const out = `wrote ${bytes} bytes to ${full}`;
    if (ctx.onChunk) ctx.onChunk(out);
    return { output: out, meta: { path: full, bytes } };
  } catch (err) {
    return { output: `error: ${err.message}`, meta: { error: true } };
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.venv', '__pycache__']);

export function grepFiles(pattern, p, opts = {}) {
  const full = resolvePath(p);
  let re;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? 'i' : '');
  } catch (err) {
    return { output: `error: bad regex: ${err.message}`, meta: { error: true } };
  }

  const hits = [];
  const MAX_HITS = 300;

  function scanFile(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // binary / unreadable — skip
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`);
        if (hits.length >= MAX_HITS) return;
      }
    }
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        scanFile(path.join(dir, e.name));
      }
    }
  }

  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else scanFile(full);
  } catch (err) {
    return { output: `error: ${err.message}`, meta: { error: true } };
  }

  if (hits.length === 0) return { output: '(no matches)', meta: { matches: 0 } };
  const truncated = hits.length >= MAX_HITS ? `\n… (capped at ${MAX_HITS} matches)` : '';
  return { output: hits.join('\n') + truncated, meta: { matches: hits.length } };
}
