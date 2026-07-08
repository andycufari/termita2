// The copilot loop (BUILDME §4). Owns message history, drives the LLM, runs ONE
// tool per round, awaits a human decision, feeds the result back, loops so the
// model can react — then returns control to the user. No UI imports.
import { Emitter, EVENTS } from './events.js';
import {
  READ_ONLY_TOOLS,
  KNOWN_TOOLS,
  executeTool,
  clampForModel,
  toolSchemas,
  braveKey,
} from '../tools/index.js';
import { shellState } from '../tools/shell.js';
import { createProvider } from '../providers/index.js';
import { buildSystemPrompt } from '../prompt/system.js';
import { SessionLog } from './log.js';

// No hard cap on tool rounds — every mutating command needs approval and Esc
// cancels anytime, so the human is the real limit. We only show a soft "still
// going" nudge after this many consecutive rounds to catch a runaway loop.
const SOFT_WARN_TURNS = 50;
const HARD_LIMIT = 1000; // absolute backstop against an infinite bug-loop

export class Engine {
  constructor({ provider, gate, system, systemPrompt }) {
    this.provider = provider;
    this.gate = gate;
    this.system = system; // machine facts
    this.systemPrompt = systemPrompt;
    this.events = new Emitter();
    this.log = new SessionLog();

    this.history = []; // OpenAI-format messages (no system; that's separate)
    this.busy = false;
    this.abort = null; // current AbortController

    // pending approval: { resolve, toolCall }
    this._pendingDecision = null;
  }

  on(fn) {
    return this.events.on(fn);
  }

  // Swap the LLM backend at runtime (e.g. after the setup wizard or a provider
  // change). Rebuilds the provider so a changed provider TYPE takes effect.
  swapProvider(llm) {
    this.provider = createProvider(llm);
  }

  // Rebuild the system prompt from current machine facts + user memory. Called
  // after the model saves/forgets a note so the change is live THIS session
  // (memory is injected by buildSystemPrompt — see prompt/system.js). Refreshes
  // cwd too, in case the model changed directories.
  rebuildSystemPrompt() {
    this.system.cwd = shellState.cwd || this.system.cwd;
    this.systemPrompt = buildSystemPrompt(this.system);
  }

  // Truncate history to just before message[idx] — used by double-Esc rewind so
  // the user can re-ask from an earlier point. Everything after idx is dropped.
  rewindTo(idx) {
    if (idx >= 0 && idx <= this.history.length) {
      this.history = this.history.slice(0, idx);
    }
  }

  // Called by the UI when the user resolves an approval card.
  // decision: { kind: 'run'|'always'|'no'|'edit', command? }
  resolveDecision(decision) {
    if (this._pendingDecision) {
      const p = this._pendingDecision;
      this._pendingDecision = null;
      p.resolve(decision);
    }
  }

  // Esc / interrupt — abort the in-flight request + child process, decline any
  // pending approval.
  interrupt() {
    if (this.abort) this.abort.abort();
    if (this._pendingDecision) this.resolveDecision({ kind: 'no', interrupted: true });
  }

  clearHistory() {
    this.history = [];
  }

  // Release session resources (per-command output files). Best-effort; safe to
  // call more than once. Invoked on app exit — see cli.js.
  dispose() {
    try { this.log.cleanup(); } catch { /* best-effort */ }
  }

  // Replace history with a compact summary message.
  setSummary(summaryText) {
    this.history = [
      { role: 'assistant', content: `[conversation summary so far]\n${summaryText}` },
    ];
  }

  async _awaitDecision(toolCall) {
    // Register the pending promise BEFORE emitting, so a synchronous listener
    // that resolves the decision during emit doesn't race ahead of the handle.
    return new Promise((resolve) => {
      this._pendingDecision = { resolve, toolCall };
      this.events.emit(EVENTS.TOOL_AWAIT, { id: toolCall.id });
    });
  }

  async _runTool(toolCall) {
    const { id, name, arguments: args } = toolCall;
    this.events.emit(EVENTS.TOOL_RUNNING, { id });

    // Full shell output streams to a per-command file so the in-memory copy can
    // stay bounded (see shell.js). onFull returns the path so shell can cite it
    // in the clamped result; we resolve the path lazily on first chunk.
    const outFile = name === 'shell' ? this.log.outFilePath(id) : null;
    const ctx = {
      cwd: shellState.cwd,
      signal: this.abort?.signal,
      onChunk: (chunk) => this.events.emit(EVENTS.TOOL_OUTPUT, { id, chunk }),
      onFull: outFile ? (chunk) => { this.log.appendOutput(outFile, chunk); return outFile; } : null,
      braveApiKey: braveKey(this.gate?.config), // for the websearch tool
    };

    if (name === 'shell') this.log.command(args.command, args.why);
    else if (name === 'write') this.log.command(`write ${args.path}`, args.why);

    let result;
    try {
      result = await executeTool(name, args, ctx);
    } catch (err) {
      result = { output: `error: ${err.message}`, meta: { error: true } };
    }
    if (name === 'shell') this.log.output(result.output, result.meta?.exitCode);
    return result;
  }

  // Run a command the USER typed directly (the `!cmd` escape hatch) — NOT proposed
  // by the model, no approval gate. `suspendRunner` (supplied by the UI) tears
  // termita's screen down, runs the command on the REAL terminal (fully
  // interactive — vim, tail -f, a REPL, plain ls), shows a pause menu on exit, and
  // returns the user's choice about what the model should hear. See interactive.js.
  //
  // We DON'T push history here. The choice becomes a *staged* context the UI puts
  // in front of the input so the user can add a comment; command-context + comment
  // are then sent together as one user turn (see app.jsx). Returns:
  //   { staged: string|null }  — text to seed the next turn, or null (silent 'E').
  // cwd tracks via fd 3 so `!cd` sticks; the system prompt is refreshed.
  async runDirect(command, { suspendRunner } = {}) {
    const cmd = String(command || '').trim();
    if (!cmd || this.busy || typeof suspendRunner !== 'function') return { staged: null };
    this.busy = true;
    this.abort = new AbortController();

    try {
      this.log.command(`!${cmd}`, 'user ran directly');
      const res = await suspendRunner(cmd, { cwd: shellState.cwd, signal: this.abort.signal });

      // Adopt the child's final $PWD so a `!cd` sticks; refresh the prompt.
      if (res?.cwd) shellState.cwd = res.cwd;
      this.rebuildSystemPrompt();

      const choice = res?.choice || 'empty';
      const codeNote = res?.exitCode != null ? ` (exit ${res.exitCode})` : '';
      let staged = null;
      if (choice === 'full' && res?.output) {
        const trimmed = clampForModel(res.output, undefined, res.outFile);
        staged = `[I ran this directly in my terminal — not a step you proposed]\n$ ${cmd}${codeNote}\n${trimmed || '(no output)'}`;
      } else if (choice === 'enter') {
        staged = `[I ran this directly in my terminal — not a step you proposed]\n$ ${cmd}${codeNote}\n(output stayed on my screen — ask if you need it)`;
      } // 'empty' → staged stays null (model told nothing)

      this.events.emit(EVENTS.NOTICE, {
        text: choice === 'empty' ? `ran \`${cmd}\` (private)` : `ran \`${cmd}\` — add a note or press enter to share`,
        level: 'dim',
      });
      return { staged };
    } catch (err) {
      if (err.name !== 'AbortError') this.events.emit(EVENTS.ERROR, { message: err.message, kind: err.kind });
      return { staged: null };
    } finally {
      this.busy = false;
      this.abort = null;
      this.events.emit(EVENTS.TURN_DONE, {});
    }
  }

  // The main loop for one user turn.
  async send(userText) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.history.push({ role: 'user', content: userText });
    this.log.user(userText);

    try {
      await this._loop();
    } catch (err) {
      if (err.name === 'AbortError') {
        this.events.emit(EVENTS.NOTICE, { text: 'interrupted', level: 'dim' });
      } else {
        this.events.emit(EVENTS.ERROR, { message: err.message, kind: err.kind });
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.events.emit(EVENTS.TURN_DONE, {});
    }
  }

  async _loop() {
    let warned = false;
    for (let turn = 0; turn < HARD_LIMIT; turn++) {
      if (turn === SOFT_WARN_TURNS && !warned) {
        warned = true;
        this.events.emit(EVENTS.NOTICE, {
          text: `${SOFT_WARN_TURNS}+ steps in a row — still going (esc to stop anytime)`,
          level: 'warn',
        });
      }
      const started = Date.now();
      let textBuf = '';
      let reasoningBuf = '';

      const resp = await this.provider.streamComplete({
        system: this.systemPrompt,
        messages: this.history,
        tools: toolSchemas(this.gate?.config), // websearch appears only if a Brave key is set
        signal: this.abort.signal,
        onToken: (t) => {
          textBuf += t;
          this.events.emit(EVENTS.TOKEN, { text: t });
        },
        onReasoning: (t) => {
          reasoningBuf += t;
          this.events.emit(EVENTS.REASONING, { text: t });
        },
      });

      const ms = Date.now() - started;

      // No tool call -> turn over.
      if (!resp.toolCalls || resp.toolCalls.length === 0) {
        const text = (resp.text || '').trim();
        this.history.push({ role: 'assistant', content: resp.text || '' });
        this.log.assistant(text);
        this.events.emit(EVENTS.ASSISTANT_DONE, { text: resp.text || '', reasoning: resp.reasoning, ms });
        // Empty reply (common with thinking models when the trace eats the token
        // budget) — tell the user instead of silently leaving a blank.
        if (!text) {
          const thinking = !!this.provider?.llm?.reasoning;
          this.events.emit(EVENTS.NOTICE, {
            text: thinking
              ? 'model returned an empty reply (thinking trace may have used the token budget — try /reasoning off or raise maxTokens)'
              : 'model returned an empty reply — try again, or raise maxTokens',
            level: 'warn',
          });
        }
        return;
      }

      // Exactly one tool call drives the round (copilot, not agent). If the model
      // emitted several, we honor the first and tell it to slow down.
      const toolCall = resp.toolCalls[0];
      const extra = resp.toolCalls.length - 1;

      // Flush any assistant prose that preceded the tool call.
      if (resp.text && resp.text.trim()) {
        this.log.assistant(resp.text);
        this.events.emit(EVENTS.ASSISTANT_DONE, { text: resp.text, reasoning: resp.reasoning, ms });
      }

      // Record the assistant tool call in history (OpenAI format).
      this.history.push({
        role: 'assistant',
        content: resp.text || '',
        tool_calls: [{
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }],
      });

      // Unknown / malformed tool -> feed an error back so the model can recover.
      if (!KNOWN_TOOLS.has(toolCall.name) || toolCall.arguments?._parseError) {
        const msg = !KNOWN_TOOLS.has(toolCall.name)
          ? `error: no such tool "${toolCall.name}"`
          : `error: could not parse tool arguments`;
        this._pushToolResult(toolCall.id, msg);
        continue;
      }

      const decision = await this._gateAndDecide(toolCall, extra);

      if (decision.skip) {
        this._pushToolResult(toolCall.id, decision.resultText, { decision: 'no' });
        continue;
      }

      // Execute.
      const result = await this._runTool(decision.toolCall);
      // If the model just saved/forgot a memory note, rebuild the system prompt
      // so it's honored on the very next round (not just next launch).
      if (result.meta?.memoryChanged) this.rebuildSystemPrompt();
      // Shell output is pre-bounded (head+tail) with its full copy on disk; pass
      // the file path so any further clamp still points the model at the full log.
      const forModel = clampForModel(result.output, undefined, result.meta?.fullPath);
      this.events.emit(EVENTS.TOOL_DONE, {
        id: decision.toolCall.id,
        output: result.output,
        meta: result.meta,
        decision: decision.kind,
      });
      this._pushToolResult(decision.toolCall.id, forModel, { decision: decision.kind });
      // loop again so the model reads the result and reacts / proposes next.
    }

    this.events.emit(EVENTS.NOTICE, {
      text: `reached ${HARD_LIMIT} steps — stopping (this shouldn't happen; esc next time)`,
      level: 'warn',
    });
  }

  // Resolve policy, possibly prompt the user, handle Edit re-gating.
  // Returns { toolCall, kind } to execute, or { skip:true, resultText }.
  async _gateAndDecide(toolCall, extraCount = 0) {
    let current = toolCall;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const gate = this.gate.resolve(current.name, current.arguments);

      // emit the proposal with its gate decision so UI can render the card
      this.events.emit(EVENTS.TOOL_PROPOSED, {
        id: current.id,
        name: current.name,
        args: current.arguments,
        gate,
        extraCount,
      });

      if (gate.action === 'auto') {
        return { toolCall: current, kind: gate.reason };
      }

      // needs a human decision
      const decision = await this._awaitDecision(current);

      if (decision.interrupted) {
        return { skip: true, resultText: 'user interrupted (esc)' };
      }

      switch (decision.kind) {
        case 'run':
          return { toolCall: current, kind: 'run' };
        case 'always': {
          if (current.name === 'shell') this.gate.bless(current.arguments.command);
          this.events.emit(EVENTS.NOTICE, {
            text: `allowlisted: ${current.name === 'shell' ? '`' + (current.arguments.command || '').split(/\s+/).slice(0, 2).join(' ') + '`' : current.name}`,
            level: 'ok',
          });
          return { toolCall: current, kind: 'always' };
        }
        case 'no':
          return { skip: true, resultText: 'user declined' };
        case 'edit': {
          // re-gate the edited command
          current = {
            ...current,
            arguments: { ...current.arguments, command: decision.command },
          };
          continue;
        }
        default:
          return { skip: true, resultText: 'user declined' };
      }
    }
  }

  _pushToolResult(toolCallId, content, extra = {}) {
    this.history.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: String(content ?? ''),
    });
    void extra;
  }
}
