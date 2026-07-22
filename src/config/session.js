// Persist the engine's conversation history so `termita -c` (continue) can resume
// the last session. The sessions/<date>.log files are a human-readable write-only
// journal; this is the STRUCTURED state (OpenAI-format messages) the engine needs
// to actually pick up where it left off.
//
// One slot — the most recent session — at ~/.config/termita/last-session.json.
// Small, atomic, best-effort: a corrupt or missing file just means a fresh start.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

function sessionPath() {
  return path.join(configDir(), 'last-session.json');
}

// Save history + a little metadata. Called on exit and after each turn so a hard
// kill still leaves a recent snapshot. `history` is the engine's message array.
export function saveSession({ history, model, cwd, savedAt }) {
  try {
    if (!Array.isArray(history) || history.length === 0) return;
    const data = { version: 1, savedAt: savedAt || null, model: model || null, cwd: cwd || null, history };
    const tmp = sessionPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, sessionPath()); // atomic: never leave a half-written file
  } catch { /* best-effort — losing a resume snapshot must never crash the app */ }
}

// Load the last session, or null if there isn't a usable one.
export function loadSession() {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.history) || data.history.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export function hasSession() {
  try { return fs.statSync(sessionPath()).size > 0; } catch { return false; }
}
