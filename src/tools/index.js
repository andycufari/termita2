// Tool registry + OpenAI-style JSON schemas sent to the model.
import { runShell } from './shell.js';
import { readFile, writeFile, grepFiles } from './fs.js';
import { webSearch } from './websearch.js';
import { addNote, forgetNote, activeNotes } from '../config/memory.js';

// The websearch schema is added CONDITIONALLY (only when a Brave key is set) so
// the model never sees a tool it can't use. See toolSchemas() below.
const WEBSEARCH_SCHEMA = {
  type: 'function',
  function: {
    name: 'websearch',
    description:
      'Search the live web via Brave and get back titles, URLs and snippets. Read-only, runs without approval. Use for current events, docs, versions, error messages, or anything outside your training data. Prefer a focused query; cite the URLs you rely on.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the search query' },
        count: { type: 'integer', description: 'how many results (1-20, default 8)' },
      },
      required: ['query'],
    },
  },
};

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        "Run a shell step on the user's machine and return its output. A step can be a single command, a chained one-liner (&&, |, ;), or a small inline script — whatever does the job cleanly in one invocation. Use for anything that touches the system. Propose one step; the user approves it before it runs, then you react to the output and propose the next step.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the exact command/chain/script, run via: sh -c <command>' },
          why: {
            type: 'string',
            description: "one short line: what this does and why you're running it (shown to the user)",
          },
        },
        required: ['command', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from disk. Read-only, runs without approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          range: { type: 'string', description: 'optional line range like "1-40"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regex. Read-only, runs without approval.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'file or dir to search (recursive for dirs)' },
          ignoreCase: { type: 'boolean' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write content to a file (creates or overwrites). Mutating — requires approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          why: { type: 'string', description: 'one short line: what and why (shown to the user)' },
        },
        required: ['path', 'content', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description:
        "Remember a durable fact the user tells you that you can't discover by running a command — a preference (\"prefers pnpm\"), a project fact (\"deploys via fly.io\"), or a constraint (\"never push to main directly\"). Call this when the user says \"remember…\", \"note that…\", \"from now on…\", or states a lasting preference. DISTILL it into one clean sentence — don't store the raw chat. Do NOT use it for things you can just check (whether a tool is installed, a service is running) — run a command for those. Saved memory is shown to you at the top of every turn. Runs without approval.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'forget'], description: "'add' saves a note, 'list' shows them, 'forget' drops note #index" },
          note: { type: 'string', description: "for action=add: the distilled fact, one sentence" },
          scope: { type: 'string', enum: ['global', 'project'], description: "'project' (default) = tied to this directory; 'global' = every session on this machine (use for machine-wide prefs)" },
          index: { type: 'integer', description: 'for action=forget: the 1-based number from the list' },
        },
        required: ['action'],
      },
    },
  },
];

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'websearch']);
export const MUTATING_TOOLS = new Set(['shell', 'write']);
export const KNOWN_TOOLS = new Set(['shell', 'read', 'grep', 'write', 'websearch', 'memory']);

// Resolve the Brave API key: config.search.braveApiKey wins, else BRAVE_API_KEY
// env var. Returns '' when neither is set (→ websearch stays hidden).
export function braveKey(config) {
  const fromCfg = config?.search?.braveApiKey;
  if (fromCfg && String(fromCfg).trim()) return String(fromCfg).trim();
  const fromEnv = process.env.BRAVE_API_KEY;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : '';
}

// The tool schemas advertised to the model, tailored to what's actually usable.
// websearch is included only when a Brave key exists — the model can't call a
// tool it never sees, so it never fails a search for a missing key.
export function toolSchemas(config) {
  const schemas = [...TOOL_SCHEMAS];
  if (braveKey(config)) schemas.push(WEBSEARCH_SCHEMA);
  return schemas;
}

// Cap on output fed back to the model (the full stream is on disk — see
// shell.js / log.js — and the UI streams it live).
export const MODEL_OUTPUT_LIMIT = 12 * 1024; // ~12KB

// Trim huge output to a head+tail so it doesn't blow the context window. When
// `fullPath` is given, the omission marker tells the model where the complete
// output lives so it can grep/read the part that was cut. Shell output is
// usually pre-bounded by shell.js (already carries this marker), so this only
// re-trims the rare case where even the bounded head+tail exceeds the limit, and
// non-shell tools (read/grep) whose raw output is large.
export function clampForModel(text, limit = MODEL_OUTPUT_LIMIT, fullPath = null) {
  if (!text || text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - limit;
  const where = fullPath ? ` — full output at ${fullPath} (grep or read it to see the rest)` : '';
  return `${head}\n\n… [${omitted} bytes omitted${where}] …\n\n${tail}`;
}

// Execute a tool. `ctx` carries cwd state + an onChunk(streamText) callback for
// live streaming (shell). Returns { output, meta }.
export async function executeTool(toolName, args, ctx = {}) {
  switch (toolName) {
    case 'shell':
      return runShell(args.command, ctx);
    case 'read':
      return readFile(args.path, args.range, ctx);
    case 'grep':
      return grepFiles(args.pattern, args.path, { ignoreCase: args.ignoreCase, ...ctx });
    case 'write':
      return writeFile(args.path, args.content, ctx);
    case 'websearch':
      return webSearch(args.query, { count: args.count, braveApiKey: ctx.braveApiKey, signal: ctx.signal });
    case 'memory':
      return runMemory(args, ctx);
    default:
      return { output: `error: unknown tool "${toolName}"`, meta: { error: true } };
  }
}

// The `memory` tool. Adds/lists/forgets durable user facts. `meta.memoryChanged`
// tells the engine to rebuild the system prompt so the new note is live THIS turn.
function runMemory(args, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const action = args.action || 'list';
  if (action === 'add') {
    const saved = addNote(args.note, { scope: args.scope === 'global' ? 'global' : 'project', cwd });
    if (!saved) return { output: 'nothing to remember (empty note)', meta: { error: true } };
    if (saved.cognito) return { output: 'incognito is on (/cognito) — not saved to memory', meta: {} };
    const verb = saved.added ? 'remembered' : 'already knew that';
    return { output: `${verb} (${saved.scope}): ${saved.note}`, meta: { memoryChanged: saved.added } };
  }
  if (action === 'forget') {
    const removed = forgetNote(Number(args.index), cwd);
    if (!removed) return { output: `no note #${args.index} to forget`, meta: {} };
    return { output: `forgot: ${removed.note}`, meta: { memoryChanged: true } };
  }
  // list
  const notes = activeNotes(cwd);
  if (!notes.length) return { output: 'no saved memory yet', meta: {} };
  const body = notes.map((n, i) => `${i + 1}. [${n.scope}] ${n.note}`).join('\n');
  return { output: body, meta: {} };
}
