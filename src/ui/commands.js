// Single source of truth for slash commands. Used by:
//  - the `/` autocomplete dropdown in the input bar (app.jsx)
//  - the help panel (banner.jsx)
//  - (the actual handlers live in slash.js)
// Keep `name` WITHOUT the leading slash; `usage` is what we show in the dropdown.
export const COMMANDS = [
  { name: 'help',      usage: '/help',              desc: 'show commands & keys', aliases: ['h', '?'] },
  { name: 'setup',     usage: '/setup',             desc: 'configure provider / model', aliases: ['config'] },
  { name: 'model',     usage: '/model [id]',        desc: 'pick a model (interactive)', aliases: [] },
  { name: 'reasoning', usage: '/reasoning on|off',  desc: 'toggle thinking trace', aliases: ['think'] },
  { name: 'maxtokens', usage: '/maxtokens [n]',     desc: 'show / set reply token budget', aliases: ['tokens'] },
  { name: 'auto',      usage: '/auto',              desc: 'toggle auto-approve (or TAB)', aliases: [] },
  { name: 'clear',     usage: '/clear',             desc: 'wipe transcript + history', aliases: ['clean'] },
  { name: 'compact',   usage: '/compact',           desc: 'summarize history, free context', aliases: [] },
  { name: 'websearch', usage: '/websearch [key]',    desc: 'set/show Brave web-search key', aliases: ['brave', 'search'] },
  { name: 'allow',     usage: '/allow',             desc: 'list allowlist rules', aliases: ['allowlist'] },
  { name: 'quit',      usage: '/quit',              desc: 'exit (or ctrl-c twice)', aliases: ['q', 'exit'] },
];

// Given the raw input string, return matching commands while the user is typing
// a slash command. Returns [] when the input isn't a (single-token) slash command.
export function matchCommands(input) {
  if (!input || input[0] !== '/') return [];
  // only suggest while typing the command word itself (no space / args yet)
  if (/\s/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  return COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases.some((a) => a.startsWith(q)),
  );
}
