// Running a command the USER typed directly (the `!cmd` escape hatch).
//
// termita owns the terminal (alt-screen + raw stdin + mouse capture). A `!`
// command runs on the REAL terminal after termita suspends. Two modes, because
// capturing output and hosting a full-screen TUI are mutually exclusive without a
// native PTY (which would break termita's "pure Node, no native build" promise):
//
//   TTY mode  (inherited stdio) — vim, htop, a REPL, tail -f. The child owns the
//     terminal, fully interactive; we can't see its bytes, so nothing is captured.
//   PIPE mode (tee'd) — ls, git, grep, a build. Output is forwarded to the real
//     screen live AND saved, so it can be shared with the model. isatty is false,
//     but these commands don't care.
//
// The caller picks the mode (see isInteractive + the `!!` force in app.jsx).
// Either way, after the child exits the CALLER shows a pause menu and reads one
// key — this module just runs the process and (for pipe mode) returns the output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// After a `!` command exits, we're on the real (normal-buffer) terminal with the
// command's output still visible. Show a small menu and read ONE keypress, so the
// user can read the output and choose what the model hears. Returns 'enter'
// (share the command line), 'full' (command + output), or 'empty' (silent).
// Pure terminal I/O — runs while termita is suspended, before it redraws.
export function pauseMenu(cmd, exitCode, { hasOutput } = {}) {
  const line = '\x1b[2m─────────────────────────────────────────────\x1b[0m';
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const cyan = (s) => `\x1b[38;2;0;229;255m${s}\x1b[0m`;
  const short = cmd.length > 40 ? cmd.slice(0, 39) + '…' : cmd;
  const code = exitCode == null ? '' : exitCode === 0 ? dim(' (exit 0)') : `\x1b[38;2;255;77;77m (exit ${exitCode})\x1b[0m`;
  const out = [
    '',
    `${line}`,
    ` ${cyan('!' + short)} finished${code}`,
    `   ${cyan('enter')} ${dim('return · tell termita you ran it (command only)')}`,
    hasOutput ? `   ${cyan('f')}     ${dim('return · share command + output with termita')}` : null,
    `   ${cyan('e')}     ${dim('return · silent, tell termita nothing')}`,
    `${line}`,
    '',
  ].filter((l) => l !== null).join('\r\n');
  try { process.stdout.write(out); } catch { /* screen gone */ }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode?.(true); } catch { /* ok */ }
    try { stdin.resume(); } catch { /* ok */ }
    const onKey = (buf) => {
      const k = buf.toString();
      let choice = null;
      if (k === '\r' || k === '\n') choice = 'enter';
      else if (/^f$/i.test(k)) choice = hasOutput ? 'full' : 'enter';
      else if (/^e$/i.test(k)) choice = 'empty';
      else if (k === '\x03') choice = 'empty'; // Ctrl-C at the menu = silent
      if (!choice) return; // ignore other keys; wait for a real choice
      stdin.removeListener('data', onKey);
      try { stdin.setRawMode?.(wasRaw); } catch { /* ok */ }
      resolve(choice);
    };
    stdin.on('data', onKey);
  });
}

// Programs that take over the whole screen — they need a real TTY, so run them in
// TTY mode (inherited), never piped. Matched on the FIRST bare word. A pipeline or
// redirect (`git log | cat`, `vim x > y`) is treated as pipe mode (not a TUI).
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

const NON_TTY_HINT = /[|<>]|&&|;/; // piped/redirected/chained → capture (pipe mode)

// Should this command run in TTY mode (full terminal, no capture)? A light
// heuristic — the user can always force TTY with `!!` (handled by the caller).
export function isInteractive(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (NON_TTY_HINT.test(cmd)) return false;
  const base = cmd.split(/\s+/)[0].replace(/.*\//, '');
  // `tail -f` is a live stream (TTY-ish); a plain `tail file` is pipe-able.
  if (base === 'tail') return /\s-\w*f/.test(cmd) || /\s--follow\b/.test(cmd);
  // bare REPL is interactive; `python x.py` / `node build.js` is not.
  if (['python', 'python3', 'node', 'ipython'].includes(base)) return cmd.split(/\s+/).length === 1;
  return FULLSCREEN.has(base);
}

// Run `command` on the real terminal, after the caller tore termita's screen down.
//   tty=true  → inherit 0/1/2 (interactive, no capture). fd 3 carries $PWD back.
//   tty=false → pipe 1/2, tee to the real stdout live AND to `outFile` on disk.
// Resolves { exitCode, cwd, output, outFile }. `signal` forwards Ctrl-C.
export function runDirectProcess(command, { cwd, signal, tty, outFile } = {}) {
  // After the command, print $PWD on fd 3 (captured out-of-band) so `!cd` sticks.
  const wrapped = `${command}\n__rc=$?\nprintf '%s' "$PWD" >&3 2>/dev/null\nexit $__rc`;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', wrapped], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        // TTY: 0/1/2 inherit the terminal (full interactivity). PIPE: 0 inherits
        // (so a prompt like `sudo` still reads the keyboard), 1/2 pipe so we can
        // tee + capture. fd 3 = $PWD in both. NOT detached — the child must stay in
        // termita's foreground group so a program reading stdin isn't SIGTTIN'd.
        stdio: tty
          ? ['inherit', 'inherit', 'inherit', 'pipe']
          : ['inherit', 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, error: err.message });
      return;
    }

    let pwdOut = '';
    if (child.stdio[3]) child.stdio[3].on('data', (b) => { pwdOut += b.toString(); });

    // PIPE mode: forward every chunk to the real screen (so the user watches it
    // live) and accumulate a bounded copy for the model. Full copy also to disk.
    let captured = '';
    const CAP_LIMIT = 256 * 1024; // bound the in-memory copy (full is on disk)
    let sink = null;
    if (!tty) {
      if (outFile) { try { sink = fs.createWriteStream(outFile, { flags: 'a' }); } catch { sink = null; } }
      const onData = (buf) => {
        try { process.stdout.write(buf); } catch { /* screen gone */ }
        if (sink) { try { sink.write(buf); } catch { /* disk full etc. */ } }
        if (captured.length < CAP_LIMIT) captured += buf.toString();
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
    }

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
      if (sink) { try { sink.end(); } catch { /* ok */ } }
      const np = pwdOut.trim();
      resolve({
        exitCode: code == null && sig ? 130 : code,
        cwd: np || null,
        output: tty ? null : captured,
        outFile: !tty && sink ? outFile : null,
      });
    };
    child.on('error', () => finish(null, null));
    child.on('close', (code, sig) => finish(code, sig));
  });
}
