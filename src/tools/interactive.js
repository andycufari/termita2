// Running a command the USER typed directly (the `!cmd` escape hatch).
//
// termita owns the terminal: it's in the ALTERNATE SCREEN with stdin in RAW mode
// and mouse capture on. A `!` command ALWAYS gets the real terminal — we don't
// guess whether it's interactive. termita suspends (tears its screen down), the
// child runs attached to the TTY (so vim, an editor prompt, htop, a REPL, plain
// `ls` — anything — behaves exactly as in your shell), then termita redraws. This
// is how git/less shell out to $EDITOR. Because the child owns stdout, we DON'T
// capture its output; the model is just told the command ran.
//
// cwd still tracks: we can't capture 1/2 (the child needs them), but we CAN keep
// fd 3 for ourselves and have the wrapper print $PWD there after the command —
// so `!cd /foo` persists into the session just like the model's shell tool does.
import { spawn } from 'node:child_process';

// Run `command` attached to the real terminal, after the caller has torn
// termita's screen down. stdin/stdout/stderr inherit the TTY; fd 3 is captured so
// the resulting $PWD comes back out-of-band (never mixed into the child's screen).
// Resolves { exitCode, cwd } when the child exits. `signal` forwards Ctrl-C.
export function runInteractive(command, { cwd, signal } = {}) {
  // Run the user's command, then emit $PWD on fd 3 (captured), preserving its rc.
  const wrapped = `${command}\n__rc=$?\nprintf '%s' "$PWD" >&3 2>/dev/null\nexit $__rc`;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', wrapped], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        // 0/1/2 inherit the real TTY (full interactivity); 3 = pwd, captured.
        // NOT detached: the child must stay in termita's process group so it's the
        // TTY's FOREGROUND group — otherwise a program that reads stdin (vim, a
        // REPL) gets SIGTTIN-stopped. Interactive input working matters more than
        // reaping a stray grandchild on the rare mid-hand-off abort (see onAbort).
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, error: err.message });
      return;
    }

    let pwdOut = '';
    if (child.stdio[3]) child.stdio[3].on('data', (b) => { pwdOut += b.toString(); });

    // Abort: SIGINT first (Ctrl-C — lets a TUI like vim/less clean up its screen),
    // then SIGKILL shortly after if it ignored it. The child shares termita's
    // group (see spawn), so we can't group-kill without also hitting ourselves;
    // we signal the child directly. A deep grandchild (`sh -c "sleep"`) may
    // outlive SIGKILL of the wrapper, but abort mid-hand-off is rare — you
    // normally just quit the program — and this keeps interactive input correct.
    let killTimer = null;
    const onAbort = () => {
      try { child.kill('SIGINT'); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 300);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => { if (killTimer) clearTimeout(killTimer); resolve({ exitCode: null, error: err.message }); });
    child.on('close', (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      const np = pwdOut.trim();
      // A signalled death (aborted) has code === null; surface that as non-zero.
      resolve({ exitCode: code == null && sig ? 130 : code, cwd: np || null });
    });
  });
}
