// Slash command handling. Pure-ish: takes the command + a bag of UI callbacks.
import { glyphs } from './ui/theme.js';
import { saveConfig } from './config/config.js';

// Mask a secret for display: keep the first 4 + last 4 chars.
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k[0] + '…' + k.slice(-1);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export async function runSlash(line, ctx) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  const { engine, config, provider, push } = ctx;

  switch (cmd) {
    case 'help':
    case 'h':
    case '?':
      ctx.showHelp();
      return;

    case 'quit':
    case 'q':
    case 'exit':
      ctx.quit();
      return;

    case 'setup':
    case 'config':
      ctx.openSetup?.();
      return;

    case 'clean':
    case 'clear':
      engine.clearHistory();
      ctx.clearTranscript();
      push({ kind: 'notice', text: 'transcript + history wiped — fresh context', level: 'ok' });
      return;

    case 'auto':
      ctx.toggleAuto();
      return;

    case 'reasoning':
    case 'think': {
      const on = /^(on|1|true|yes)$/i.test(arg);
      const off = /^(off|0|false|no)$/i.test(arg);
      if (!on && !off) { ctx.setReasoning(!config.llm.reasoning); }
      else ctx.setReasoning(on);
      return;
    }

    case 'model': {
      // explicit id still works: `/model gpt-4o`. No arg opens the interactive
      // arrow-key picker (fetches the list, no typing the id by hand).
      if (arg) { ctx.setModel(arg); return; }
      await ctx.openModelPicker();
      return;
    }

    case 'maxtokens':
    case 'tokens': {
      if (!arg) {
        push({ kind: 'notice', text: `maxTokens: ${config.llm.maxTokens} — /maxtokens <n> to change`, level: 'dim' });
        return;
      }
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 256) {
        push({ kind: 'notice', text: `maxTokens must be an integer ≥ 256 (got "${arg}")`, level: 'warn' });
        return;
      }
      ctx.setMaxTokens(n);
      return;
    }

    case 'context':
    case 'ctx': {
      if (!arg) {
        push({ kind: 'notice', text: `context window: ${(config.llm.contextSize || 8192).toLocaleString()} tokens — /context <n> to change (e.g. /context 32768)`, level: 'dim' });
        return;
      }
      // accept "32768", "32k", "128K"
      const m = /^(\d+)\s*([kK])?$/.exec(arg.trim());
      const n = m ? Number.parseInt(m[1], 10) * (m[2] ? 1024 : 1) : NaN;
      if (!Number.isFinite(n) || n < 256) {
        push({ kind: 'notice', text: `context window must be an integer ≥ 256 (got "${arg}")`, level: 'warn' });
        return;
      }
      ctx.setContextSize(n);
      return;
    }

    case 'allow':
    case 'allowlist': {
      const rules = config.policy.allowlist;
      if (!rules.length) { push({ kind: 'notice', text: 'allowlist empty', level: 'dim' }); return; }
      push({ kind: 'msg', who: 'term', text: `allowlist:\n${rules.map((r) => `  ${glyphs.check} ${r}`).join('\n')}` });
      return;
    }

    case 'websearch':
    case 'brave':
    case 'search': {
      // /websearch            → show status
      // /websearch <key>      → set + persist the Brave API key
      // /websearch off|clear  → remove the key (hides the tool again)
      config.search = config.search || { braveApiKey: '', enabled: true };
      if (!arg) {
        const cfgKey = config.search.braveApiKey;
        const envKey = !cfgKey && process.env.BRAVE_API_KEY;
        if (cfgKey) push({ kind: 'notice', text: `web search ON — Brave key ${maskKey(cfgKey)} (set)`, level: 'ok' });
        else if (envKey) push({ kind: 'notice', text: `web search ON — using BRAVE_API_KEY env var`, level: 'ok' });
        else push({ kind: 'notice', text: 'web search OFF — set a key: /websearch <brave-api-key>  ·  get one at api-dashboard.search.brave.com', level: 'dim' });
        return;
      }
      if (/^(off|clear|none|remove)$/i.test(arg)) {
        config.search.braveApiKey = '';
        saveConfig(config);
        push({ kind: 'notice', text: 'Brave key cleared — web search disabled (env var still applies if set)', level: 'warn' });
        return;
      }
      config.search.braveApiKey = arg;
      saveConfig(config);
      push({ kind: 'notice', text: `Brave key saved ${maskKey(arg)} — web search enabled ${glyphs.check}`, level: 'ok' });
      return;
    }

    case 'mouse': {
      // /mouse            → toggle wheel capture
      // /mouse on|off     → set explicitly
      const on = /^(on|1|true|yes)$/i.test(arg);
      const off = /^(off|0|false|no)$/i.test(arg);
      ctx.toggleMouse(on ? true : off ? false : undefined);
      return;
    }

    case 'credits':
    case 'about':
      push({ kind: 'msg', who: 'term', text: '🏴‍☠️ termita 🇦🇷\n@andycufari · 2026\nEnjoy the ride 🏴‍☠️ 🇦🇷' });
      return;

    default:
      push({ kind: 'notice', text: `unknown command: /${cmd} — try /help`, level: 'warn' });
  }
}

// Ask the model to summarize history, then replace it with the summary.
async function compact(ctx) {
  const { engine, provider, push } = ctx;
  if (engine.history.length < 2) { push({ kind: 'notice', text: 'nothing to compact', level: 'dim' }); return; }
  push({ kind: 'notice', text: 'compacting…', level: 'dim' });
  try {
    const summaryReq = [
      ...engine.history,
      { role: 'user', content: 'Summarize our conversation so far into a tight note I can use as memory: key facts, decisions, current state, and anything in-flight. Bullet points, no fluff.' },
    ];
    let summary = '';
    await provider.streamComplete({
      system: 'You compress conversations into compact, factual notes.',
      messages: summaryReq,
      tools: [],
      onToken: (t) => { summary += t; },
    });
    engine.setSummary(summary.trim() || '(empty)');
    push({ kind: 'notice', text: `compacted — history is now a ${summary.length}-char note`, level: 'ok' });
  } catch (err) {
    push({ kind: 'error', message: `compact failed: ${err.message}` });
  }
}
