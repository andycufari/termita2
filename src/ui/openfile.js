// Load a file for the viewer pane.
//
// Kept out of the component so opening is a pure, testable function: it decides
// the render mode, enforces the size cap, and reports failures as data rather
// than throwing into a render.
import fs from 'node:fs';
import path from 'node:path';
import { shellState } from '../tools/shell.js';
import { sanitizeOutput } from '../tools/sanitize.js';

// Files above this aren't opened whole. The viewer is for reading source and
// notes, and holding a 50MB log as an array of lines in a React state would
// stall the render loop — the shell pane (`less`, `tail`) is the right tool for
// those.
export const MAX_VIEW_BYTES = 2 * 1024 * 1024; // 2MB

const MD_EXT = new Set(['.md', '.markdown', '.mdx']);

export function resolveViewPath(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (s.startsWith('~')) s = s.replace(/^~/, process.env.HOME || '');
  return path.isAbsolute(s) ? s : path.resolve(shellState.cwd || process.cwd(), s);
}

export function openFile(p) {
  const full = resolveViewPath(p);
  if (!full) return { missing: true };
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // A directory opens as a LISTING rather than an error — browsing to a
      // folder and getting "EISDIR" would make the viewer feel broken when the
      // obvious next step is "show me what's in here".
      const entries = fs.readdirSync(full, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort((a, b) => {
          const ad = a.endsWith('/'), bd = b.endsWith('/');
          if (ad !== bd) return ad ? -1 : 1; // dirs first, Norton-style
          return a.localeCompare(b);
        });
      return {
        path: full, name: path.basename(full) + '/', dir: true,
        lines: entries.length ? entries : ['(empty dir)'],
        offset: 0, hOffset: 0, rendered: false,
      };
    }
    if (stat.size > MAX_VIEW_BYTES) {
      return {
        path: full,
        error: `${path.basename(full)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — too big to view (limit ${MAX_VIEW_BYTES / 1024 / 1024}MB). Use the shell pane: less ${full}`,
      };
    }
    const raw = fs.readFileSync(full, 'utf8');
    // Same sanitiser the shell output goes through: a file can contain escape
    // sequences too (logs especially), and Ink must be the only thing that
    // writes control codes to the screen.
    const clean = sanitizeOutput(raw);
    const ext = path.extname(full).toLowerCase();
    return {
      path: full,
      name: path.basename(full),
      lines: clean.split('\n'),
      offset: 0,
      hOffset: 0,
      // Markdown opens RENDERED by default — that's the case the user actually
      // has (reading .md notes); `m` toggles to raw when the source matters.
      rendered: MD_EXT.has(ext),
      markdown: MD_EXT.has(ext),
    };
  } catch (err) {
    return { path: full, error: `cannot open ${p}: ${err.message}` };
  }
}

export default openFile;
