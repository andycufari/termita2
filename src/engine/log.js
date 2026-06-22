// Session logfile — plain readable text, written to
// ~/.config/termita/sessions/<date>.log. Write-only (for the user's reference /
// debugging). Best-effort: logging never throws into the app.
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

export class SessionLog {
  constructor() {
    this.file = null;
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      this.file = path.join(dir, `${day}.log`);
      this._write(`\n=== session started ${new Date().toISOString()} ===\n`);
    } catch {
      this.file = null; // logging disabled if we can't open the file
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

  get path() { return this.file; }
}
