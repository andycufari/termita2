// Session logfile — plain readable text, written to
// ~/.config/termita/sessions/<date>.log. Write-only (for the user's reference /
// debugging). Best-effort: logging never throws into the app.
//
// Full command output is ALSO written, untruncated, to a per-command file under
// sessions/<date>/cmd-<id>.out. The model only ever holds a bounded head+tail of
// big output in context; when it needs the middle it greps/reads that file (its
// path is handed to the model in the clamped result). This keeps memory bounded
// without losing any output — see loop.js / shell.js / tools/index.js.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/config.js';

function sessionsDir() {
  return path.join(configDir(), 'sessions');
}

function stamp() {
  // HH:MM:SS, local time
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

// Sanitise a tool-call id into a safe filename fragment. Ids originate from the
// model/provider, so they must never be trusted as raw path components.
function safeId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'cmd';
}

// Prune per-command output folders older than KEEP_DAYS so the sessions dir
// can't grow without bound across many days. Best-effort; runs once at startup.
const KEEP_DAYS = 7;
function pruneOldSessions() {
  try {
    const dir = sessionsDir();
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      // only touch our dated output folders (YYYY-MM-DD), never the .log files
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort: no sessions dir yet, or unreadable */ }
}

export class SessionLog {
  constructor() {
    this.file = null;
    this.outDir = null;        // sessions/<date>/ — holds per-command .out files
    this._outFiles = [];       // paths written this session, for exit cleanup
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      this.file = path.join(dir, `${day}.log`);
      this.outDir = path.join(dir, day);
      this._write(`\n=== session started ${new Date().toISOString()} ===\n`);
      pruneOldSessions();
    } catch {
      this.file = null; // logging disabled if we can't open the file
      this.outDir = null;
    }
  }

  _write(line) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, line); } catch { /* best-effort */ }
  }

  user(text) { this._write(`[${stamp()}] you: ${text}\n`); }

  assistant(text) {
    if (text && text.trim()) this._write(`[${stamp()}] term: ${text.trim()}\n`);
  }

  command(cmd, why) {
    this._write(`[${stamp()}] $ ${cmd}${why ? `   # ${why}` : ''}\n`);
  }

  output(text, exitCode) {
    const body = (text || '').split('\n').map((l) => `    ${l}`).join('\n');
    this._write(`${body}\n  [exit ${exitCode ?? '?'}]\n`);
  }

  note(text) { this._write(`[${stamp()}] · ${text}\n`); }

  // The path a command's FULL output should stream to, addressable by tool-call
  // id. Returns null if logging is disabled. Creating the dir lazily keeps empty
  // sessions from leaving a folder behind.
  outFilePath(id) {
    if (!this.outDir) return null;
    try {
      fs.mkdirSync(this.outDir, { recursive: true });
    } catch { return null; }
    const p = path.join(this.outDir, `cmd-${safeId(id)}.out`);
    return p;
  }

  // Append a chunk of a command's full output to its per-command file. Tracks the
  // path so it can be cleaned up on exit. Best-effort; never throws.
  appendOutput(filePath, chunk) {
    if (!filePath || !chunk) return;
    try {
      fs.appendFileSync(filePath, chunk);
      if (!this._outFiles.includes(filePath)) this._outFiles.push(filePath);
    } catch { /* best-effort */ }
  }

  // Remove this session's per-command output files (called on clean exit). The
  // daily .log survives; only the potentially-large .out files are cleared.
  cleanup() {
    for (const p of this._outFiles) {
      try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
    this._outFiles = [];
    // drop the now-empty dated folder if nothing else wrote to it
    if (this.outDir) {
      try { fs.rmdirSync(this.outDir); } catch { /* not empty / gone — fine */ }
    }
  }

  get path() { return this.file; }
}
