// Approval policy: allowlist (user-blessed command shapes), danger patterns,
// and auto-approve mode. Decides whether a tool call needs a human prompt.
import { saveConfig } from '../config/config.js';

// Commands that match these can NEVER be silently auto-allowed. They always
// prompt with a loud warning — even in auto-approve mode, even if allowlisted.
// The user is root of their own box; we don't hard-block, we make it loud.
export const DANGER_PATTERNS = [
  { re: /\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf]/i, label: 'recursive/forced delete (rm -rf)' },
  { re: /\brm\s+.*\b(\/|~|\$HOME)\b/i, label: 'rm targeting / or home' },
  { re: /\bmkfs(\.\w+)?\b/i, label: 'format filesystem (mkfs)' },
  { re: /\bdd\b.*\bof=\/dev\//i, label: 'raw write to a device (dd of=/dev/…)' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, label: 'power/reboot the machine' },
  { re: /:\s*\(\s*\)\s*\{[\s\S]*\}\s*;?\s*:/, label: 'fork bomb' },
  { re: />\s*\/dev\/sd[a-z]/i, label: 'overwrite a block device' },
  { re: /\bchmod\s+-R\s+0?00?7?77\b/i, label: 'recursive chmod 777' },
  { re: /\bchown\s+-R\b.*\b(\/|root)\b/i, label: 'recursive chown on system paths' },
  { re: /\b(curl|wget)\b.*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, label: 'pipe remote script to a shell' },
  { re: /\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/i, label: 'destructive git op' },
  { re: /\b>\s*\/etc\//i, label: 'overwrite a file in /etc' },
  { re: /\btruncate\b.*-s\s*0/i, label: 'truncate file to zero' },
];

export function dangerHit(command) {
  for (const d of DANGER_PATTERNS) {
    if (d.re.test(command)) return d.label;
  }
  return null;
}

// Normalize a command into an allowlist "shape": the first meaningful token.
// "ls -la /tmp" -> "ls". "sudo systemctl status x" -> "sudo systemctl".
// "git status" -> "git status" (keep subcommand for multiplexers like git/docker).
const MULTIPLEXERS = new Set(['git', 'docker', 'npm', 'pnpm', 'yarn', 'kubectl', 'systemctl', 'brew', 'cargo', 'go', 'apt', 'dnf', 'pacman']);

// Broad/slow/destructive-by-scope commands where the PATH arg matters: blessing
// "find ." must NOT bless "find /". For these we key on command + first path arg.
// (grep/rg excluded: their first arg is the PATTERN, not a path — keying on it is
// misleading, and grep doesn't mutate, so name-level blessing is acceptable.)
const SCOPED = new Set(['find', 'du', 'tar', 'rsync', 'cp', 'mv', 'chmod', 'chown', 'tree', 'fd']);

export function commandShape(command) {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  // skip leading env assignments  FOO=bar cmd
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

  let prefix = '';
  if (tokens[i] === 'sudo' && tokens[i + 1]) {
    prefix = 'sudo ';
    i++;
  }

  const head = tokens[i] || '';
  let shape = prefix + head;
  const rest = tokens.slice(i + 1);
  const sub = rest[0];

  // multiplexers (git, docker, …): keep the subcommand for precision
  if (MULTIPLEXERS.has(head) && sub && !sub.startsWith('-')) {
    shape = `${shape} ${sub}`;
  } else if (SCOPED.has(head)) {
    // scoped commands: append the first non-flag arg that looks like a path/root,
    // so "find ." and "find /" are DIFFERENT allowlist entries.
    const pathArg = rest.find((t) => !t.startsWith('-'));
    if (pathArg) shape = `${shape} ${pathArg}`;
  }
  return shape;
}

// The Gate: holds policy state, decides what to do with a proposed tool call.
export class Gate {
  constructor(config) {
    this.config = config;
    this.policy = config.policy;
  }

  get autoApprove() {
    return !!this.policy.autoApprove;
  }

  setAutoApprove(on) {
    this.policy.autoApprove = !!on;
  }

  isAllowlisted(command) {
    const shape = commandShape(command);
    return this.policy.allowlist.includes(shape);
  }

  // Persist a new "Always" rule for this command shape.
  bless(command) {
    const shape = commandShape(command);
    if (!this.policy.allowlist.includes(shape)) {
      this.policy.allowlist.push(shape);
      try { saveConfig(this.config); } catch { /* non-fatal */ }
    }
    return shape;
  }

  unbless(shape) {
    this.policy.allowlist = this.policy.allowlist.filter((s) => s !== shape);
    try { saveConfig(this.config); } catch { /* non-fatal */ }
  }

  // Decide how to handle a tool call.
  // returns { action: 'auto' | 'prompt', reason, danger }
  //   auto   -> run without asking
  //   prompt -> show the approval card
  resolve(toolName, args) {
    // read-only tools always auto-run
    if (toolName === 'read' || toolName === 'grep') {
      return { action: 'auto', reason: 'read-only' };
    }

    // memory (save/list/forget a user note) is a safe local write — auto-run.
    if (toolName === 'memory') {
      return { action: 'auto', reason: 'memory' };
    }

    const command = toolName === 'shell' ? args.command : `write ${args.path}`;
    const danger = toolName === 'shell' ? dangerHit(args.command) : null;

    // danger ALWAYS prompts, loudly — overrides allowlist and auto-approve
    if (danger) {
      return { action: 'prompt', reason: 'danger', danger };
    }

    // explicit allowlist match -> auto
    if (toolName === 'shell' && this.isAllowlisted(args.command)) {
      return { action: 'auto', reason: 'allowlisted' };
    }

    // auto-approve mode -> auto (shell + write), danger already handled above
    if (this.autoApprove) {
      return { action: 'auto', reason: 'auto-approve' };
    }

    return { action: 'prompt', reason: 'mutating', command };
  }
}
