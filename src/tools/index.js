// Tool registry + OpenAI-style JSON schemas sent to the model.
import { runShell } from './shell.js';
import { readFile, writeFile, grepFiles } from './fs.js';

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
];

export const READ_ONLY_TOOLS = new Set(['read', 'grep']);
export const MUTATING_TOOLS = new Set(['shell', 'write']);
export const KNOWN_TOOLS = new Set(['shell', 'read', 'grep', 'write']);

// Cap on output fed back to the model (the UI still sees the full stream).
export const MODEL_OUTPUT_LIMIT = 12 * 1024; // ~12KB

// Trim huge output head+tail so it doesn't blow the context window.
export function clampForModel(text, limit = MODEL_OUTPUT_LIMIT) {
  if (!text || text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - limit;
  return `${head}\n\n… [${omitted} bytes omitted] …\n\n${tail}`;
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
    default:
      return { output: `error: unknown tool "${toolName}"`, meta: { error: true } };
  }
}
