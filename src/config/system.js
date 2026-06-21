// Probe the machine so the model knows what it's sitting on. Cached to system.json.
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { configDir, SYSTEM_PATH } from './config.js';

const COMMON_TOOLS = [
  'git', 'docker', 'docker-compose', 'systemctl', 'node', 'npm', 'pnpm', 'yarn',
  'python3', 'python', 'pip', 'go', 'rustc', 'cargo', 'curl', 'wget', 'jq',
  'rg', 'fd', 'fzf', 'tmux', 'nginx', 'psql', 'mysql', 'redis-cli', 'kubectl',
  'ss', 'lsof', 'htop', 'make', 'gcc', 'brew', 'apt', 'dnf', 'pacman', 'ssh',
];

function which(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function readOsRelease() {
  try {
    const txt = fs.readFileSync('/etc/os-release', 'utf8');
    const map = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) map[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return map;
  } catch {
    return null;
  }
}

function macVersion() {
  try {
    return execSync('sw_vers -productVersion', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return os.release();
  }
}

function inferPkgManager(platform, available) {
  if (platform === 'darwin') return available.includes('brew') ? 'brew' : '(none — install Homebrew)';
  for (const pm of ['apt', 'dnf', 'pacman']) if (available.includes(pm)) return pm;
  return 'unknown';
}

export function probeSystem() {
  const platform = os.platform();
  const osRelease = platform === 'linux' ? readOsRelease() : null;

  let distro, version;
  if (platform === 'darwin') {
    distro = 'macOS';
    version = macVersion();
  } else if (osRelease) {
    distro = osRelease.PRETTY_NAME || osRelease.NAME || 'Linux';
    version = osRelease.VERSION_ID || '';
  } else {
    distro = platform;
    version = os.release();
  }

  const available = COMMON_TOOLS.filter(which);

  const sys = {
    platform,
    distro,
    version,
    arch: os.arch(),
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: os.homedir(),
    cwd: process.cwd(),
    shell: process.env.SHELL || '/bin/sh',
    pkgManager: inferPkgManager(platform, available),
    available,
    probedAt: new Date().toISOString(),
  };
  return sys;
}

export function saveSystem(sys) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(SYSTEM_PATH(), JSON.stringify(sys, null, 2) + '\n', 'utf8');
}

export function loadSystem() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_PATH(), 'utf8'));
  } catch {
    return null;
  }
}

// Always returns fresh-enough facts: load cache, but refresh cwd (changes per launch).
export function getSystem({ refresh = false } = {}) {
  let sys = refresh ? null : loadSystem();
  if (!sys) {
    sys = probeSystem();
    saveSystem(sys);
  }
  sys.cwd = process.cwd();
  return sys;
}
