// Detecting + running full-screen interactive programs (vim, htop, less…).
//
// termita owns the terminal: it's in the ALTERNATE SCREEN with stdin in RAW mode
// and mouse capture on. A full-screen program needs those exact same things — it
// wants the real TTY as its stdin/stdout, the alt screen, and raw keystrokes.
// There's no way to host one inside an Ink layout (Ink paints text; it can't
// embed a live PTY). So for these we SUSPEND: tear termita's screen down, hand
// the real terminal to the child, and redraw termita when the child exits. This
// is exactly how git/less/fzf shell out to $EDITOR.
import { spawn } from 'node:child_process';

// Programs that take over the whole screen (they need the TTY; capturing their
// output is meaningless). Matched on the FIRST bare word of a command — a
// pipeline or one with redirection (`git log | cat`, `vim x > y`) is treated as
// normal (non-interactive), since the user clearly isn't running it full-screen.
const FULLSCREEN = new Set([
  'vim', 'vi', 'nvim', 'neovim', 'nano', 'pico', 'emacs', 'emacsclient',
  'helix', 'hx', 'kak', 'micro', 'joe', 'ne',
  'less', 'more', 'most',
  'top', 'htop', 'btop', 'atop', 'glances', 'gtop', 'bpytop',
  'man', 'tig', 'lazygit', 'gitui', 'lazydocker', 'k9s',
  'ncdu', 'ranger', 'nnn', 'lf', 'vifm', 'mc', 'yazi',
  'watch', 'fzf', 'sk', 'ssh', 'mosh', 'tmux', 'screen',
  'nmtui', 'nethack', 'vit', 'calcurse', 'cmus', 'ncmpcpp',
  'python', 'python3', 'ipython', 'node', 'irb', 'ghci', 'sqlite3', 'psql', 'mysql', 'redis-cli',
]);

// Some pagers/editors are safe when clearly non-interactive (piped/redirected);
// if the command contains a pipe, redirect, or command separator we DON'T treat
// it as full-screen — it isn't running as a TUI.
const NON_TTY_HINT = /[|<>]|&&|;|\bcat\b\s*$/;

// Is this direct command a full-screen program we should suspend-and-hand-off?
export function isInteractive(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (NON_TTY_HINT.test(cmd)) return false; // piped/redirected → capture normally
  const first = cmd.split(/\s+/)[0];
  const base = first.replace(/.*\//, ''); // strip any path prefix
  // bare REPL only (e.g. `python` with no script arg) is interactive; `python x.py` isn't
  if (['python', 'python3', 'node'].includes(base)) {
    return cmd.split(/\s+/).length === 1;
  }
  return FULLSCREEN.has(base);
}

// Run a command attached to the REAL terminal (inherited stdio), after the caller
// has torn termita's screen down. Resolves when the child exits. `signal` aborts
// it (Esc). Returns { exitCode } — output isn't captured (it went to the TTY).
export function runInteractive(command, { cwd, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', command], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        stdio: 'inherit', // child owns the real TTY: keyboard + screen
      });
    } catch (err) {
      resolve({ exitCode: null, error: err.message });
      return;
    }
    const onAbort = () => { try { child.kill('SIGINT'); } catch { /* gone */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => resolve({ exitCode: null, error: err.message }));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({ exitCode: code });
    });
  });
}
