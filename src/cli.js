#!/usr/bin/env node
// Entry point: parse argv (init | doctor | run-default), bootstrap, render Ink.
import process from 'node:process';
import { loadConfig, saveConfig, configExists, CONFIG_PATH, SYSTEM_PATH } from './config/config.js';
import { probeSystem, saveSystem, getSystem } from './config/system.js';

const argv = process.argv.slice(2);
const sub = argv[0];

// minimal ansi for non-Ink subcommands
const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function cmdInit({ probe } = {}) {
  console.log(c.magenta(c.bold('\n  termita init\n')));
  const sys = probeSystem();
  saveSystem(sys);
  console.log(`  ${c.green('✓')} probed system → ${c.dim(SYSTEM_PATH())}`);
  console.log(`    ${c.dim(`${sys.distro} ${sys.version} · ${sys.arch} · ${sys.user}@${sys.hostname}`)}`);
  console.log(`    ${c.dim(`pkg: ${sys.pkgManager} · tools: ${sys.available.length} found`)}`);

  if (!configExists()) {
    const cfg = loadConfig();
    saveConfig(cfg);
    console.log(`  ${c.green('✓')} wrote config → ${c.dim(CONFIG_PATH())}`);
    console.log(`    ${c.dim(`endpoint: ${cfg.llm.endpoint} · model: ${cfg.llm.model}`)}`);
    console.log(c.dim('\n  edit the config to point at your LM Studio endpoint, then run `termita`.\n'));
  } else {
    console.log(`  ${c.green('✓')} config exists → ${c.dim(CONFIG_PATH())}`);
  }
  if (probe) console.log(c.dim('  (re-probed)'));
}

async function cmdDoctor() {
  console.log(c.cyan(c.bold('\n  termita doctor\n')));
  const cfg = loadConfig();
  console.log(`  config:   ${configExists() ? c.green('found') : c.yellow('using defaults')} ${c.dim(CONFIG_PATH())}`);
  console.log(`  provider: ${c.cyan(cfg.llm.provider || 'openai-compatible')}`);
  console.log(`  endpoint: ${c.cyan(cfg.llm.endpoint || '(provider default)')}`);
  console.log(`  model:    ${c.cyan(cfg.llm.model)}`);

  // node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  console.log(`  node:     ${major >= 20 ? c.green(process.version) : c.red(process.version + ' (need ≥20)')}`);

  // probe endpoint
  process.stdout.write(`  reaching ${cfg.llm.provider === 'anthropic' ? 'Anthropic' : 'endpoint'} … `);
  try {
    const { createProvider } = await import('./providers/index.js');
    const provider = createProvider(cfg.llm);
    const models = await provider.listModels();
    console.log(c.green(`ok (${models.length} models)`));
    const has = models.includes(cfg.llm.model);
    console.log(`  model ${c.cyan(cfg.llm.model)}: ${has ? c.green('available') : c.yellow('NOT in list — run /model')}`);
    if (!has && models.length) console.log(c.dim(`    available: ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}`));
  } catch (err) {
    console.log(c.red('FAILED'));
    console.log(c.dim(`    ${err.message}`));
    console.log(c.dim(`    → is LM Studio running and serving at that endpoint?`));
  }
  console.log('');
}

function help() {
  console.log(`
  ${c.magenta(c.bold('termita'))} ${c.dim('2.0 — terminal copilot')}

  ${c.bold('usage')}
    termita            ${c.dim('open the chat TUI')}
    termita init       ${c.dim('probe system + write config')}
    termita doctor     ${c.dim('check endpoint, model, node')}
    termita --help     ${c.dim('this')}
`);
}

async function bootstrapTUI() {
  // auto-init on first run
  if (!configExists()) {
    await cmdInit();
    console.log(c.dim('  launching…\n'));
  }
  const config = loadConfig();
  const system = getSystem();

  const [{ default: React }, { render }] = await Promise.all([
    import('react'),
    import('ink'),
  ]);
  const { createProvider } = await import('./providers/index.js');
  const { Engine } = await import('./engine/loop.js');
  const { buildSystemPrompt } = await import('./prompt/system.js');
  const { Gate } = await import('./policy/gate.js');
  const { default: App } = await import('./app.jsx');

  const provider = createProvider(config.llm);
  const gate = new Gate(config);
  const systemPrompt = buildSystemPrompt(system);
  const engine = new Engine({ provider, gate, system, systemPrompt });

  // warn if endpoint is non-local (output leaves the machine)
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.llm.endpoint);

  const { waitUntilExit } = render(
    React.createElement(App, { engine, config, provider, isLocal }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

(async () => {
  try {
    if (sub === 'init') await cmdInit({ probe: argv.includes('--probe') });
    else if (sub === 'doctor') await cmdDoctor();
    else if (sub === '--help' || sub === '-h' || sub === 'help') help();
    else if (sub === '--version' || sub === '-v') console.log('termita 2.0.0');
    else await bootstrapTUI();
  } catch (err) {
    console.error(c.red(`\ntermita: ${err.stack || err.message}\n`));
    process.exit(1);
  }
})();
