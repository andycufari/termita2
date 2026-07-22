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
import { runShell, shellState } from '../tools/shell.js';
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
    this._bangSeq = 0; // ids for user-run `!cmd` (distinct from model tool ids)
    this.onPersist = null; // set by cli.js to snapshot history for `termita -c`

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
    this._persist();
  }

  // Load a prior conversation (for `termita -c`). Replaces history wholesale.
  restoreHistory(history) {
    if (Array.isArray(history) && history.length) this.history = history;
  }

  // Snapshot history so `termita -c` can resume. cli.js wires onPersist to write
  // ~/.config/termita/last-session.json. Best-effort and cheap; called whenever
  // history changes so a hard kill still leaves a recent snapshot.
  _persist() {
    try { this.onPersist?.(this.history); } catch { /* best-effort */ }
  }

  // Re-run the last user turn. For the common "model returned an empty reply"
  // case: drop a trailing empty assistant message (and re-send the same user
  // content) so a flaky local model gets another shot without you retyping.
  // Returns false if there's nothing to retry.
  async retry() {
    if (this.busy) return false;
    // strip a trailing empty/whitespace assistant reply — that's the dud
    while (this.history.length && this.history.at(-1).role === 'assistant'
           && !String(this.history.at(-1).content || '').trim()) {
      this.history.pop();
    }
    const lastUser = [...this.history].reverse().find((m) => m.role === 'user');
    if (!lastUser) return false;
    // pop everything from the last user turn onward, then re-send it
    const idx = this.history.lastIndexOf(lastUser);
    const content = lastUser.content;
    this.history = this.history.slice(0, idx);
    await this.send(content);
    return true;
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

  // Ask the model to summarize the conversation so far, then collapse history to
  // that summary — frees context on a long session without wiping it. Returns
  // { ok, before, after } token-ish sizes, or { ok:false } if there's nothing to
  // compact or a turn is running.
  async compact() {
    if (this.busy || this.history.length < 2) return { ok: false };
    const before = this.history.length;
    const transcript = this.history
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[content]'}`)
      .join('\n');
    let summary = '';
    try {
      const resp = await this.provider.streamComplete({
        system: 'Summarize this terminal-assistant conversation compactly: the task, key facts learned, commands run and their results, and any open threads. Be terse; this replaces the history.',
        messages: [{ role: 'user', content: transcript }],
        onToken: () => {},
        onReasoning: () => {},
      });
      summary = (resp.text || '').trim();
    } catch {
      return { ok: false };
    }
    if (!summary) return { ok: false };
    this.setSummary(summary);
    return { ok: true, before, after: this.history.length };
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

  // Build the staged "I ran this myself" turn from a `!cmd` + the user's share
  // choice. Returns the text to seed the next turn, or null (silent 'empty').
  // Shared by both `!` paths (pipe + tty). cmd-context + the user's comment are
  // sent together as one user turn by the UI; we DON'T push history here.
  stageDirect(cmd, { choice, output, outFile, exitCode }) {
    const codeNote = exitCode != null ? ` (exit ${exitCode})` : '';
    if (choice === 'full' && output && output.trim()) {
      const trimmed = clampForModel(output, undefined, outFile);
      return `[I ran this directly in my terminal — not a step you proposed]\n$ ${cmd}${codeNote}\n${trimmed}`;
    }
    if (choice === 'enter' || (choice === 'full' && !output)) {
      return `[I ran this directly in my terminal — not a step you proposed]\n$ ${cmd}${codeNote}\n(output stayed on my screen — ask if you need it)`;
    }
    return null; // 'empty' → model told nothing
  }

  // `!cmd` PIPE path: run a plain command WITHOUT leaving termita. Output streams
  // into the transcript via the same events as a tool run (so it renders live and
  // scrolls, and is never lost to a screen flash). No approval gate. Returns
  // { output, outFile, exitCode } so the UI can offer the share menu. cwd tracks.
  async runBangShell(cmd, { onEvent } = {}) {
    if (!cmd || this.busy) return null;
    this.busy = true;
    this.abort = new AbortController();
    const id = `bang-${++this._bangSeq}`;
    try {
      this.log.command(`!${cmd}`, 'user ran directly');
      // No `why`: the user typed this, so "you ran this yourself" was noise on
      // every single card. The model's own tool calls still carry a real reason.
      this.events.emit(EVENTS.TOOL_PROPOSED, { id, name: 'shell', args: { command: cmd }, gate: null });
      this.events.emit(EVENTS.TOOL_RUNNING, { id });
      const outFile = this.log.outFilePath(id);
      const result = await runShell(cmd, {
        cwd: shellState.cwd,
        signal: this.abort.signal,
        onChunk: (chunk) => this.events.emit(EVENTS.TOOL_OUTPUT, { id, chunk }),
        onFull: outFile ? (chunk) => { this.log.appendOutput(outFile, chunk); return outFile; } : null,
      });
      this.log.output(result.output, result.meta?.exitCode);
      this.events.emit(EVENTS.TOOL_DONE, { id, output: result.output, meta: result.meta });
      if (result.meta?.cwd) { shellState.cwd = result.meta.cwd; this.rebuildSystemPrompt(); }
      return { output: result.output, outFile: result.meta?.fullPath || outFile, exitCode: result.meta?.exitCode };
    } catch (err) {
      if (err.name !== 'AbortError') this.events.emit(EVENTS.ERROR, { message: err.message, kind: err.kind });
      return null;
    } finally {
      this.busy = false;
      this.abort = null;
      this.events.emit(EVENTS.TURN_DONE, {});
      this._persist();
    }
  }

  // `!cmd` TTY path: a full-screen program (vim, htop, tail -f, or forced with
  // `!!`) that must own the real terminal. `suspendRunner` (from the UI) tears
  // termita's screen down, runs it interactive, and redraws. Nothing to capture,
  // so no share menu — we just record the command (unless empty). cwd tracks via
  // fd 3. Returns { staged } for the UI to seed the comment prompt.
  async runBangTty(cmd, { suspendRunner } = {}) {
    if (!cmd || this.busy || typeof suspendRunner !== 'function') return { staged: null };
    this.busy = true;
    this.abort = new AbortController();
    try {
      this.log.command(`!${cmd}`, 'user ran directly (interactive)');
      const res = await suspendRunner(cmd, { cwd: shellState.cwd, signal: this.abort.signal });
      if (res?.cwd) { shellState.cwd = res.cwd; }
      this.rebuildSystemPrompt();
      const staged = this.stageDirect(cmd, { choice: 'enter', exitCode: res?.exitCode });
      this.events.emit(EVENTS.NOTICE, { text: `ran \`${cmd}\` — add a note or press enter to share`, level: 'dim' });
      return { staged };
    } catch (err) {
      if (err.name !== 'AbortError') this.events.emit(EVENTS.ERROR, { message: err.message, kind: err.kind });
      return { staged: null };
    } finally {
      this.busy = false;
      this.abort = null;
      this.events.emit(EVENTS.TURN_DONE, {});
      this._persist();
    }
  }

  // The main loop for one user turn. `content` is either a plain string, or an
  // OpenAI content-parts array (text + image_url parts) when the user attached an
  // image (see attach.js). The provider passes `content` straight through, so a
  // parts array reaches the model as native multimodal input.
  async send(content) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.history.push({ role: 'user', content });
    // Log a readable string form (arrays carry image blobs we don't want in logs).
    this.log.user(typeof content === 'string' ? content : summarizeContent(content));

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
      this._persist();
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
        // Empty reply — tell the user instead of leaving a blank, and point at the
        // ACTUAL cause. `truncated` (finish_reason=length, no text) means the model
        // hit max_tokens; if the reasoning trace is where the budget went, the fix
        // is maxTokens or /reasoning off, NOT the context window (a common
        // confusion — the ctx gauge can read 4% while this fires).
        if (!text) {
          const max = this.provider?.llm?.maxTokens ?? 4096;
          let msg;
          if (resp.truncated && resp.reasoningLen > 0) {
            // Ran out of OUTPUT budget mid-thinking. Only claim this when the
            // reasoning trace is actually large relative to the budget — a short
            // trace + empty text is the intermittent case below, not truncation.
            msg = `model spent its ${max}-token output budget thinking before it replied — /maxtokens ${max * 2} or /reasoning off. (This is the output budget, not the context window.)`;
          } else if (resp.truncated) {
            msg = `model hit the ${max}-token output limit with nothing to show — /maxtokens ${max * 2}.`;
          } else {
            // Not a token issue — the model just returned nothing. Common with
            // abliterated/thinking local models; retrying usually works. Don't
            // send people to raise maxTokens when that isn't the cause.
            msg = 'model returned an empty reply (some local models do this intermittently) — just send again, or /retry.';
          }
          this.events.emit(EVENTS.NOTICE, { text: msg, level: 'warn' });
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

// Readable one-line summary of a content-parts array, for the session log (we
// don't want a base64 image blob in the plaintext log). Text parts pass through;
// image parts become a short marker.
function summarizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((p) => {
    if (p?.type === 'text') return p.text || '';
    if (p?.type === 'image_url') return '[image attached]';
    return '';
  }).filter(Boolean).join('\n');
}
