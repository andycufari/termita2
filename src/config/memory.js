// User memory: facts the user tells termita to remember that it can't probe —
// prefs ("prefer pnpm"), project facts ("deploys via fly"), constraints
// ("never touch main"). Distinct from machine facts (config/system.js), which
// termita discovers itself. Persisted to ~/.config/termita/memory.json.
//
// Shape:
//   { global: [ "..." ],                 // machine-wide, applied everywhere
//     project: { "<abs cwd>": [ "..." ] } // keyed to the directory it was set in
//   }
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

const MEMORY_PATH = () => path.join(configDir(), 'memory.json');
const MAX_NOTES = 100; // sanity backstop per bucket; oldest dropped past this

// Incognito ("/cognito"): a SESSION-only flag (never persisted — resets off each
// launch). When on, memory is a full blackout: nothing is recalled (activeNotes
// returns empty, so the prompt injects no memory) AND nothing is saved (addNote
// no-ops). Turn it back off and everything already on disk returns untouched.
let cognito = false;
export function setCognito(on) { cognito = !!on; }
export function isCognito() { return cognito; }

function empty() {
  return { global: [], project: {} };
}

export function loadMemory() {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH(), 'utf8'));
    return {
      global: Array.isArray(raw.global) ? raw.global : [],
      project: raw.project && typeof raw.project === 'object' ? raw.project : {},
    };
  } catch {
    return empty();
  }
}

export function saveMemory(mem) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(MEMORY_PATH(), JSON.stringify(mem, null, 2) + '\n', 'utf8');
}

// The notes that apply RIGHT NOW: global + whatever was saved for this cwd.
// Returns a flat list of { scope, note } for display/injection.
export function activeNotes(cwd = process.cwd()) {
  if (cognito) return []; // blackout: recall nothing this session
  const mem = loadMemory();
  const out = [];
  for (const note of mem.global) out.push({ scope: 'global', note });
  for (const note of mem.project[cwd] || []) out.push({ scope: 'project', note });
  return out;
}

// Add a note. scope: 'global' | 'project' (defaults to project — most facts are
// repo-specific; the model passes 'global' for machine-wide prefs). Dedupes
// case-insensitively so "remember X" twice doesn't stack. Returns the saved note.
export function addNote(note, { scope = 'project', cwd = process.cwd() } = {}) {
  const clean = String(note || '').trim();
  if (!clean) return null;
  if (cognito) return { scope, note: clean, added: false, cognito: true }; // blackout: don't persist
  const mem = loadMemory();
  const bucket = scope === 'global' ? mem.global : (mem.project[cwd] ||= []);
  const exists = bucket.some((n) => n.toLowerCase() === clean.toLowerCase());
  if (!exists) {
    bucket.push(clean);
    while (bucket.length > MAX_NOTES) bucket.shift();
  }
  if (scope !== 'global') mem.project[cwd] = bucket;
  saveMemory(mem);
  return { scope, note: clean, added: !exists };
}

// Forget the Nth active note (1-based, matching what /memory list shows).
// Returns the removed note, or null if out of range.
export function forgetNote(index, cwd = process.cwd()) {
  const active = activeNotes(cwd);
  const target = active[index - 1];
  if (!target) return null;
  const mem = loadMemory();
  const bucket = target.scope === 'global' ? mem.global : (mem.project[cwd] || []);
  const at = bucket.findIndex((n) => n === target.note);
  if (at === -1) return null;
  bucket.splice(at, 1);
  if (target.scope === 'project') {
    if (bucket.length) mem.project[cwd] = bucket;
    else delete mem.project[cwd]; // don't leave empty dir keys around
  }
  saveMemory(mem);
  return target;
}

// Wipe memory. scope 'all' clears everything; 'project' clears just this cwd;
// 'global' clears the global bucket. Returns how many notes were removed.
export function clearMemory({ scope = 'all', cwd = process.cwd() } = {}) {
  const mem = loadMemory();
  let removed = 0;
  if (scope === 'all') {
    removed = mem.global.length + Object.values(mem.project).reduce((a, b) => a + b.length, 0);
    saveMemory(empty());
  } else if (scope === 'global') {
    removed = mem.global.length;
    mem.global = [];
    saveMemory(mem);
  } else {
    removed = (mem.project[cwd] || []).length;
    delete mem.project[cwd];
    saveMemory(mem);
  }
  return removed;
}
