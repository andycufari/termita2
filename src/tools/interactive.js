// Deciding + running a full-screen `!cmd` on the REAL terminal.
//
// A plain `!cmd` (ls, git, grep) runs INSIDE termita via the shell tool, so its
// output streams into the transcript (see engine runBangShell). But a full-screen
// program — vim, htop, a REPL, `tail -f` — needs to OWN the terminal (raw keys,
// cursor control, its own alt-screen); it can't render inside Ink. For those,
// termita suspends and hands off the real TTY, then redraws when the child exits.
// This module: (1) the heuristic that picks which path, (2) the TTY runner.
import { spawn } from 'node:child_process';

// Programs that take over the whole screen — they need a real TTY. Matched on the
// FIRST bare word. A pipeline/redirect/chain (`git log | cat`, `vim x > y`) is NOT
// treated as full-screen — the user clearly isn't running it as a TUI.
const FULLSCREEN = new Set([
  'vim', 'vi', 'nvim', 'neovim', 'nano', 'pico', 'emacs', 'emacsclient',
  'helix', 'hx', 'kak', 'micro', 'joe', 'ne',
  'less', 'more', 'most',
  'top', 'htop', 'btop', 'atop', 'glances', 'gtop', 'bpytop',
  'man', 'tig', 'lazygit', 'gitui', 'lazydocker', 'k9s',
  'ncdu', 'ranger', 'nnn', 'lf', 'vifm', 'mc', 'yazi',
  'watch', 'tail', 'fzf', 'sk', 'ssh', 'mosh', 'tmux', 'screen',
  'nmtui', 'nethack', 'vit', 'calcurse', 'cmus', 'ncmpcpp',
  'python', 'python3', 'ipython', 'node', 'irb', 'ghci', 'sqlite3', 'psql', 'mysql', 'redis-cli',
]);

const NON_TTY_HINT = /[|<>]|&&|;/; // piped/redirected/chained → run in-app (pipe)

// Should this `!cmd` take over the whole terminal (suspend + hand off)? A light
// heuristic — the user can always force it with `!!` (handled in app.jsx).
export function isInteractive(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (NON_TTY_HINT.test(cmd)) return false;
  const base = cmd.split(/\s+/)[0].replace(/.*\//, '');
  // `tail -f` is a live stream (TTY-ish); a plain `tail file` runs in-app.
  if (base === 'tail') return /\s-\w*f/.test(cmd) || /\s--follow\b/.test(cmd);
  // bare REPL is interactive; `python x.py` / `node build.js` is not.
  if (['python', 'python3', 'node', 'ipython'].includes(base)) return cmd.split(/\s+/).length === 1;
  return FULLSCREEN.has(base);
}

// Run `command` attached to the REAL terminal, after the caller tore termita's
// screen down. stdin/stdout/stderr inherit the TTY (full interactivity); fd 3 is
// captured so the resulting $PWD comes back out-of-band (so `!cd` sticks). Output
// isn't captured — the child owns the screen. Resolves { exitCode, cwd }.
export function runDirectProcess(command, { cwd, signal } = {}) {
  // After the command, print $PWD on fd 3 (captured), preserving its exit code.
  const wrapped = `${command}\n__rc=$?\nprintf '%s' "$PWD" >&3 2>/dev/null\nexit $__rc`;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', wrapped], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        // 0/1/2 inherit the terminal; 3 = pwd, captured. NOT detached — the child
        // must stay in termita's foreground group or a program reading stdin (vim,
        // a REPL) gets SIGTTIN-stopped.
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, error: err.message });
      return;
    }

    let pwdOut = '';
    if (child.stdio[3]) child.stdio[3].on('data', (b) => { pwdOut += b.toString(); });

    // Abort: SIGINT first (Ctrl-C — lets a TUI clean up its screen), then SIGKILL.
    let killTimer = null;
    const onAbort = () => {
      try { child.kill('SIGINT'); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 300);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const np = pwdOut.trim();
      resolve({ exitCode: code == null && sig ? 130 : code, cwd: np || null });
    };
    child.on('error', () => finish(null, null));
    child.on('close', (code, sig) => finish(code, sig));
  });
}
