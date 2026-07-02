// Config load/save. Lives at ~/.config/termita/config.json (respects XDG_CONFIG_HOME).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'termita');
}

export const CONFIG_PATH = () => path.join(configDir(), 'config.json');
export const SYSTEM_PATH = () => path.join(configDir(), 'system.json');

export const DEFAULT_CONFIG = {
  llm: {
    provider: 'openai-compatible', // "openai-compatible" | "openai" | "anthropic"
    endpoint: 'http://localhost:1234/v1', // base URL (openai-compatible)
    model: 'qwen3.6-27b',
    apiKey: 'lm-studio', // ignored by LM Studio; required by OpenAI/Anthropic
    maxTokens: 16384,
    contextSize: 8192, // model context window, for the token gauge in the footer
    reasoning: false,
  },
  ui: { theme: 'neon' },
  policy: { allowlist: [], autoRunReadOnly: true, autoApprove: false },
  // Web search (Brave). Empty key → the websearch tool stays hidden from the
  // model. Set via `/websearch <key>` or the BRAVE_API_KEY env var.
  search: { braveApiKey: '', enabled: true },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null) return over ?? base;
  if (typeof over !== 'object' || over === null) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  // Merge over defaults so a partial config object can never clobber the file
  // (e.g. dropping the whole llm block). Always write a complete config.
  const full = deepMerge(DEFAULT_CONFIG, config || {});
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(full, null, 2) + '\n', 'utf8');
}

export function configExists() {
  try {
    fs.accessSync(CONFIG_PATH());
    return true;
  } catch {
    return false;
  }
}
