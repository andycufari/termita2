// Shell tool: run ONE command via `sh -c`, stream output live, track cwd.
// cwd persistence strategy (BUILDME §13 option a): after the command runs we
// print its final $PWD to a DEDICATED fd (3), captured separately, so the cwd
// marker NEVER mixes into stdout/stderr — no sentinel can ever leak into output.
import { spawn } from 'node:child_process';

// Live state shared across calls in one session.
export const shellState = {
  cwd: process.cwd(),
};

export function runShell(command, ctx = {}) {
  const { onChunk, signal } = ctx;
  const cwd = ctx.cwd || shellState.cwd;

  // Run the user's command, then emit $PWD on fd 3 (captured out-of-band).
  const wrapped = `${command}\n__rc=$?\nprintf '%s' "$PWD" >&3 2>/dev/null\nexit $__rc`;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', ['-c', wrapped], {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        // detached -> child is its own process-group leader, so on Esc we can
        // kill the WHOLE group (the command + anything it spawned: servers,
        // watchers, `tail -f`, `npm run dev`, etc.), not just the `sh` parent.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'], // 0 in, 1 out, 2 err, 3 = pwd
      });
    } catch (err) {
      resolve({ output: `error: failed to spawn shell: ${err.message}`, meta: { error: true } });
      return;
    }

    let raw = '';
    let pwdOut = '';
    let killed = false;

    // fd 3: the resulting cwd, out-of-band (never in raw output)
    if (child.stdio[3]) {
      child.stdio[3].on('data', (b) => { pwdOut += b.toString(); });
    }

    const onData = (buf) => {
      const s = buf.toString();
      raw += s;
      if (onChunk && s) onChunk(s);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const killTree = () => {
      killed = true;
      try {
        // negative pid = the whole process group (works because detached:true)
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    };

    if (signal) {
      if (signal.aborted) killTree();
      else signal.addEventListener('abort', killTree, { once: true });
    }

    child.on('error', (err) => {
      if (err.name === 'AbortError' || killed) {
        resolve({ output: cleanOutput(raw) + '\n[interrupted]', meta: { interrupted: true, exitCode: null } });
      } else {
        resolve({ output: `error: ${err.message}`, meta: { error: true } });
      }
    });

    child.on('close', (code) => {
      // recover cwd from the out-of-band fd (never in output)
      const np = pwdOut.trim();
      if (np) shellState.cwd = np;

      const output = cleanOutput(raw);
      if (killed) {
        resolve({ output: (output ? output + '\n' : '') + '[interrupted]', meta: { interrupted: true, exitCode: null } });
        return;
      }
      const tail = code === 0 ? '' : `\n[exit ${code}]`;
      resolve({
        output: (output || '(no output)') + tail,
        meta: { exitCode: code, cwd: shellState.cwd },
      });
    });
  });
}

function cleanOutput(raw) {
  return raw.replace(/\s+$/, '');
}
