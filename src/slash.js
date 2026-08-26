// Slash command handling. Pure-ish: takes the command + a bag of UI callbacks.
import { glyphs } from './ui/theme.js';
import { saveConfig } from './config/config.js';
import {
  activeNotes as memActiveNotes,
  addNote as memAddNote,
  forgetNote as memForgetNote,
  clearMemory as memClearMemory,
  setCognito as memSetCognito,
  isCognito as memIsCognito,
} from './config/memory.js';

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

    case 'retry':
    case 'r': {
      const ok = await engine.retry();
      if (!ok) push({ kind: 'notice', text: 'nothing to retry', level: 'warn' });
      return;
    }

    case 'compact': {
      push({ kind: 'notice', text: 'summarizing conversation…', level: 'dim' });
      const res = await engine.compact();
      if (res.ok) {
        push({ kind: 'notice', text: `compacted ${res.before} messages → 1 summary (${res.chars} chars) · /uncompact to undo`, level: 'ok' });
      } else {
        // Always say the history survived. The old message ("nothing to compact")
        // was ambiguous about whether it had eaten the conversation or not.
        push({ kind: 'notice', text: `${res.reason || 'could not compact'} — nothing was discarded`, level: 'warn' });
      }
      return;
    }

    case 'uncompact': {
      const res = engine.undoCompact();
      push(res.ok
        ? { kind: 'notice', text: `restored ${res.restored} messages from before the last compact`, level: 'ok' }
        : { kind: 'notice', text: 'nothing to restore (undo is available only right after a /compact)', level: 'warn' });
      return;
    }

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

    case 'memory':
    case 'mem': {
      // /memory                 → list active notes (global + this project)
      // /memory add <note>      → save a project note
      // /memory add -g <note>   → save a global note
      // /memory forget <n>      → drop note #n
      // /memory clear           → wipe everything
      const [sub, ...subRest] = arg.split(/\s+/);
      const subArg = subRest.join(' ').trim();
      if (!arg || sub === 'list') {
        const notes = memActiveNotes();
        if (!notes.length) { push({ kind: 'notice', text: 'no saved memory — tell termita "remember …" or /memory add <note>', level: 'dim' }); return; }
        push({ kind: 'msg', who: 'term', text: 'memory:\n' + notes.map((n, i) => `  ${i + 1}. [${n.scope}] ${n.note}`).join('\n') });
        return;
      }
      if (sub === 'add') {
        let scope = 'project', text = subArg;
        if (/^-g\b/.test(text) || /^--global\b/.test(text)) { scope = 'global'; text = text.replace(/^(-g|--global)\s*/, ''); }
        const saved = memAddNote(text, { scope });
        if (!saved) { push({ kind: 'notice', text: 'nothing to save — /memory add <note>', level: 'warn' }); return; }
        push({ kind: 'notice', text: `remembered (${saved.scope}): ${saved.note}`, level: 'ok' });
        ctx.memoryChanged?.();
        return;
      }
      if (sub === 'forget' || sub === 'rm') {
        const removed = memForgetNote(Number(subArg));
        push({ kind: 'notice', text: removed ? `forgot: ${removed.note}` : `no note #${subArg}`, level: removed ? 'ok' : 'warn' });
        if (removed) ctx.memoryChanged?.();
        return;
      }
      if (sub === 'clear' || sub === 'wipe') {
        const n = memClearMemory({ scope: 'all' });
        push({ kind: 'notice', text: `memory cleared (${n} note${n === 1 ? '' : 's'})`, level: 'ok' });
        ctx.memoryChanged?.();
        return;
      }
      push({ kind: 'notice', text: 'usage: /memory · /memory add [-g] <note> · /memory forget <n> · /memory clear', level: 'dim' });
      return;
    }

    case 'cognito':
    case 'incognito': {
      // Session-only privacy blackout: no save + no recall. /cognito toggles;
      // /cognito on|off sets explicitly. Routed through the UI so the footer
      // indicator updates and the system prompt rebuilds (recall flips now).
      const on = /^(on|1|true|yes)$/i.test(arg);
      const off = /^(off|0|false|no)$/i.test(arg);
      const next = on ? true : off ? false : !memIsCognito();
      ctx.toggleCognito?.(next);
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

    case 'dual': {
      // /dual          → toggle the split layout
      // /dual on|off   → set explicitly
      const on = /^(on|1|true|yes)$/i.test(arg);
      const off = /^(off|0|false|no)$/i.test(arg);
      ctx.toggleDual?.(on ? true : off ? false : undefined);
      return;
    }

    case 'view':
    case 'v': {
      // /view <path>  → open that file in the viewer pane
      // /view         → pick from the files the model just mentioned
      // /view off     → close the viewer
      if (/^(off|close|x)$/i.test(arg)) { ctx.closeView?.(); return; }
      if (!arg) { ctx.pickView?.(); return; }
      ctx.openView?.(arg);
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
