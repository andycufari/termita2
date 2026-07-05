// Shell tool: run ONE command via `sh -c`, stream output live, track cwd.
// cwd persistence strategy (BUILDME §13 option a): after the command runs we
// print its final $PWD to a DEDICATED fd (3), captured separately, so the cwd
// marker NEVER mixes into stdout/stderr — no sentinel can ever leak into output.
//
// Memory: a command can print an unbounded amount (cat a huge file, a chatty
// build). We DON'T hold it all in RAM — that's what drove the process to a 4GB
// V8 OOM in long sessions. Instead we keep a bounded head+tail in memory (enough
// for the return value + the model's clamped view) and stream the FULL output to
// a per-command file on disk via ctx.onFull. When the model needs the omitted
// middle it greps/reads that file (its path is surfaced in the clamped result).
import { spawn } from 'node:child_process';

// Live state shared across calls in one session.
export const shellState = {
  cwd: process.cwd(),
};

// How much output we retain IN MEMORY. The full stream still goes to disk via
// ctx.onFull; these only bound the string handed back for the transcript/model.
const HEAD_LINES = 200;   // keep the first N lines (how the command started)
const TAIL_LINES = 400;   // keep the last N lines (where errors/exit usually are)
const MAX_LINE_LEN = 4096; // clamp a single pathological line (e.g. minified blob)

// A bounded ring that remembers the first HEAD_LINES and the last TAIL_LINES of a
// text stream fed to it as arbitrary chunks, plus how many lines were dropped in
// the middle. Never retains more than HEAD_LINES + TAIL_LINES lines.
function makeLineWindow() {
  const head = [];
  const tail = [];
  let dropped = 0;
  let partial = '';        // trailing incomplete line, completed by the next chunk

  const pushLine = (line) => {
    const l = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + '…[line truncated]' : line;
    if (head.length < HEAD_LINES) { head.push(l); return; }
    tail.push(l);
    if (tail.length > TAIL_LINES) { tail.shift(); dropped++; }
  };

  return {
    push(chunk) {
      const s = partial + chunk;
      const parts = s.split('\n');
      partial = parts.pop(); // last piece may be incomplete
      for (const p of parts) pushLine(p);
    },
    // finish + render the bounded string, inserting a marker for the gap.
    render(fullPath) {
      if (partial) { pushLine(partial); partial = ''; }
      if (dropped === 0) return head.concat(tail).join('\n');
      const where = fullPath
        ? ` — full output at ${fullPath} (grep or read that file to see the rest)`
        : '';
      const marker = `\n… [${dropped} lines omitted${where}] …\n`;
      return head.join('\n') + marker + tail.join('\n');
    },
  };
}

export function runShell(command, ctx = {}) {
  const { onChunk, signal, onFull } = ctx;
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

    const win = makeLineWindow(); // bounded head+tail kept in memory
    let fullPath = null;          // per-command file the FULL output streams to
    let pwdOut = '';
    let killed = false;

    // fd 3: the resulting cwd, out-of-band (never in raw output)
    if (child.stdio[3]) {
      child.stdio[3].on('data', (b) => { pwdOut += b.toString(); });
    }

    const onData = (buf) => {
      const s = buf.toString();
      if (!s) return;
      win.push(s);                 // bounded: only head+tail survive in RAM
      if (onFull) fullPath = onFull(s) || fullPath; // stream full output to disk
      if (onChunk) onChunk(s);     // live to the transcript
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
        resolve({ output: cleanOutput(win.render(fullPath)) + '\n[interrupted]', meta: { interrupted: true, exitCode: null } });
      } else {
        resolve({ output: `error: ${err.message}`, meta: { error: true } });
      }
    });

    child.on('close', (code) => {
      // recover cwd from the out-of-band fd (never in output)
      const np = pwdOut.trim();
      if (np) shellState.cwd = np;

      const output = cleanOutput(win.render(fullPath));
      if (killed) {
        resolve({ output: (output ? output + '\n' : '') + '[interrupted]', meta: { interrupted: true, exitCode: null } });
        return;
      }
      const tail = code === 0 ? '' : `\n[exit ${code}]`;
      resolve({
        output: (output || '(no output)') + tail,
        meta: { exitCode: code, cwd: shellState.cwd, fullPath },
      });
    });
  });
}

function cleanOutput(raw) {
  return raw.replace(/\s+$/, '');
}
