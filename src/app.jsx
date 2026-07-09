// Ink root. Renders the transcript, captures input + approval keys + slash
// commands, subscribes to engine events. The engine is UI-agnostic; this is the
// only place that knows about both.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import { EVENTS } from './engine/events.js';
import { theme, glyphs } from './ui/theme.js';
import { Banner, HelpPanel } from './ui/banner.jsx';
import {
  Message, StreamingMessage, ToolCard, OutputStream, ApprovalMenu, APPROVAL_ACTIONS, Notice, ErrorBox, Spinner,
  CommandMenu, MascotTag,
} from './ui/components.jsx';
import { saveConfig } from './config/config.js';
import { setCognito as memSetCognito } from './config/memory.js';
import { runDirectProcess, isInteractive } from './tools/interactive.js';
import { runSlash } from './slash.js';
import Setup from './ui/setup.jsx';
import { useTerminalSize } from './ui/use-terminal-size.js';
import { useMouseWheel } from './ui/use-mouse-wheel.js';
import { matchCommands } from './ui/commands.js';
import { VERSION } from './cli.js';

let _id = 0;
const uid = () => `i${++_id}`;

// Hard cap on how many transcript items we keep IN MEMORY (on-screen scrollback).
// Alt-screen has no native scrollback, so `items` is the whole visible history —
// left unbounded it climbed to a 4GB V8 OOM in long sessions. The full output of
// every command is on disk (see shell.js / log.js), so trimming the oldest
// on-screen lines loses nothing recoverable: the model still greps the disk log.
// Kept modest on purpose — this also caps per-keystroke render/layout cost.
const MAX_ITEMS = 600;
const TRIM_TO = 550; // trim in a batch (not every append) to avoid array churn

// Row-budget scroll (see shownItems in render). These are ESTIMATES — Ink doesn't
// expose measured heights — tuned to be slightly generous so the flex-end clip
// never leaves the viewport half-empty. BANNER_ROWS approximates the always-first
// banner block; CHROME_ROWS is the fixed input+footer area below the transcript.
const BANNER_ROWS = 9;
const CHROME_ROWS = 6;

// Estimate how many terminal rows an item renders to, so scrolling can move by
// rows instead of by items (items vary from 1 row to a dozen). Close enough:
// wrap long text by the column width, add the fixed margins each kind carries.
function itemRows(it, cols) {
  const w = Math.max(20, (cols || 80) - 2);
  const wrap = (s, indent = 0) => Math.max(1, Math.ceil((String(s || '').length + indent) / Math.max(10, w - indent)));
  switch (it.kind) {
    case 'msg': {
      // role tag (1) + body (wrapped, indent 2) + bottom margin (1); model
      // replies are markdown and often multi-line — count newlines too.
      const lines = String(it.text || '').split('\n');
      let body = 0;
      for (const ln of lines) body += wrap(ln, 2);
      return 1 + body + 1 + (it.reasoning ? 1 : 0);
    }
    case 'output': return wrap(it.text, 4);
    case 'tool': return 2;
    case 'tooldone': return 1;
    case 'notice': return wrap(it.text, 2);
    case 'error': return wrap(it.message, 2) + 2;
    case 'trim': return 1;
    case 'help': return 16;
    default: return 1;
  }
}

// Append items with a bounded length. When we exceed MAX_ITEMS we drop the
// oldest down to TRIM_TO and leave a single marker so it's clear the on-screen
// history was clipped (the full logs are still on disk). The marker carries a
// running total of everything dropped so far, so repeated trims read as one
// growing "N earlier lines trimmed" line rather than stacking up.
function appendItems(cur, added) {
  // Separate any existing trim marker from the real items first, so its historical
  // count is never re-counted as freshly-dropped lines (that double-counted).
  let prior = 0;
  let base = cur;
  if (cur[0]?.kind === 'trim') { prior = cur[0].count || 0; base = cur.slice(1); }

  const next = added.length ? base.concat(added) : base;
  if (next.length <= (prior ? MAX_ITEMS - 1 : MAX_ITEMS)) {
    // still within budget — keep the marker (if any) at the front, untouched
    return prior ? [cur[0], ...next] : next;
  }
  const dropped = next.length - TRIM_TO; // real items removed this trim
  const kept = next.slice(dropped);
  return [{ _k: uid(), kind: 'trim', count: prior + dropped }, ...kept];
}

export default function App({ engine, config, provider, needsSetup }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin, setRawMode } = useStdin();

  const [setupOpen, setSetupOpen] = useState(!!needsSetup);
  const [items, setItems] = useState([]); // transcript items
  const [input, setInput] = useState('');
  const [stream, setStream] = useState(null); // { text, thinking }
  const [pending, setPending] = useState(null); // active approval { id, name, args, gate }
  const [selected, setSelected] = useState(0); // highlighted approval action index
  const [editing, setEditing] = useState(null); // { id, value } when Editing a command
  const [busy, setBusy] = useState(false);
  const [busyAt, setBusyAt] = useState(null);
  const [queue, setQueue] = useState([]); // messages typed while busy, sent next turn
  const [autoApprove, setAutoApprove] = useState(config.policy.autoApprove);
  const [reasoning, setReasoning] = useState(config.llm.reasoning);
  const [model, setModel] = useState(config.llm.model);
  const [contextSize, setContextSize] = useState(config.llm.contextSize || 8192);
  const [mouseCapture, setMouseCapture] = useState(config.ui?.mouseCapture !== false); // wheel-scroll vs native select
  const [cognito, setCognito] = useState(false); // incognito: memory blackout (session-only)
  const [status, setStatus] = useState(null);
  const [repaint, setRepaint] = useState(0); // bump to force a full redraw after suspend/hand-off
  const [pendingShare, setPendingShare] = useState(null); // staged `!cmd` context awaiting a comment
  const [shareMenu, setShareMenu] = useState(null); // { cmd, output, outFile, exitCode, sel } after a pipe `!cmd`

  const [rewind, setRewind] = useState(null); // { points:[{idx,text}], sel } when in jump-back mode
  const [cmdSel, setCmdSel] = useState(0); // highlighted item in the `/` autocomplete
  const [picker, setPicker] = useState(null); // { models:[id], sel } interactive /model picker

  const { columns, rows } = useTerminalSize(); // reactive terminal size (responsive)

  // In-app transcript scroll (alt-screen has no native scrollback). `scrollUp`
  // is how many ROWS we've scrolled UP from the bottom; 0 = pinned to bottom
  // (auto-follows new output). Rows — not items — because items have wildly
  // different heights (a wrapped message vs a one-line output), so scrolling by
  // item count lurched unevenly and Home sliced the list empty (→ blank screen,
  // the "goes to the top and bypasses history" bug). We clamp to the total
  // content height minus a viewport so you can never scroll past the oldest line.
  const [scrollUp, setScrollUp] = useState(0);
  const maxScrollRef = useRef(0);   // total rows - viewport; set during render
  const totalRowsRef = useRef(0);   // estimated rows of the whole transcript
  const viewportRef = useRef(10);   // estimated rows the transcript viewport can show

  // Step the scroll by N ROWS (clamped to [0, maxScroll]): +up = older, -down =
  // latest. Shared by the wheel, PgUp/PgDn and Ctrl+↑/↓ so all stay consistent.
  const scrollBy = useCallback((step) => {
    setScrollUp((s) => Math.max(0, Math.min(maxScrollRef.current, s + step)));
  }, []);

  const inputHistory = useRef([]);
  const histIdx = useRef(-1);
  const ctrlC = useRef(0);
  const lastEsc = useRef(0); // timestamp of last Esc, for double-Esc detection
  // Coalesce: ONE physical Esc reaches handleEscape up to 3× in the same tick
  // (mouse-wheel hook + main useInput + PromptInput useInput all fire — see #esc).
  // Without this, the 2nd same-tick call satisfies the <600ms double-Esc window
  // and jump-back would open on a SINGLE press. We stamp the tick and ignore any
  // repeat within a few ms, so a burst counts as one logical Esc.
  const escBurst = useRef(0);
  const outputBuffers = useRef({}); // id -> accumulated live output
  const queueRef = useRef([]); // mirror of `queue` for the engine event closure
  const itemsRef = useRef([]); // mirror of `items` for the wheel-scroll closure
  // Live mirrors of the "is something running?" state. handleEscape is captured
  // by PromptInput's useInput once and NOT re-subscribed when the callback's deps
  // change, so reading busy/stream/pending directly would be STALE (usually
  // false) — Esc would fall through to the rewind path instead of interrupting.
  // Refs are always current, so Esc reliably aborts a running command. (see #esc)
  const busyRef = useRef(false);
  const streamRef = useRef(null);
  const pendingRef = useRef(null);
  const rewindRef = useRef(null);
  const setupRef = useRef(false);
  const mouseCaptureRef = useRef(config.ui?.mouseCapture !== false); // read by suspendRunner
  const [lastOutputAt, setLastOutputAt] = useState(null); // ts of last live output line

  const push = useCallback((item) => setItems((cur) => appendItems(cur, [{ _k: uid(), ...item }])), []);

  // keep queueRef in sync so the engine event closure can read the latest queue
  useEffect(() => { queueRef.current = queue; }, [queue]);

  // keep itemsRef in sync so the wheel-scroll callback can clamp without
  // re-subscribing stdin on every transcript change
  useEffect(() => { itemsRef.current = items; }, [items]);

  // keep the "running?" mirrors current for the stable handleEscape (see refs above)
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { streamRef.current = stream; }, [stream]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { rewindRef.current = rewind; }, [rewind]);
  useEffect(() => { setupRef.current = setupOpen; }, [setupOpen]);
  useEffect(() => { mouseCaptureRef.current = mouseCapture; }, [mouseCapture]);

  // mouse wheel → scroll the in-app transcript; lone Esc → interrupt (safety net
  // for when Ink's parser holds Esc back, see use-mouse-wheel.js). Esc goes
  // through a ref because handleEscape is defined below; the ref is always the
  // latest version. One wheel tick = 3 items so a flick moves a chunk (matches
  // PgUp/PgDn). Alt-screen has no native scrollback, so this makes the wheel work.
  const handleEscapeRef = useRef(() => {});
  useMouseWheel(
    useCallback((delta) => scrollBy(delta * 3), [scrollBy]),
    useCallback(() => handleEscapeRef.current(), []),
    mouseCapture,
  );

  // reset the autocomplete highlight whenever the typed command changes
  useEffect(() => { setCmdSel(0); }, [input]);

  // Keep the scroll position stable when the transcript grows. If we're scrolled
  // up and new content arrives, bump `scrollUp` by the ROWS added so the view
  // stays anchored on the same content instead of drifting toward the bottom.
  // (When pinned to bottom, scrollUp stays 0 and auto-follows.) Shrinks (/clear,
  // rewind) are handled by the clamp against maxScroll during render.
  const prevTotalRows = useRef(0);
  useEffect(() => {
    const total = totalRowsRef.current;
    const delta = total - prevTotalRows.current;
    prevTotalRows.current = total;
    if (delta > 0) setScrollUp((s) => (s > 0 ? s + delta : 0)); // anchored only when already scrolled up
  }, [items]);

  const patchItem = useCallback((id, patch) => {
    setItems((cur) => cur.map((it) => (it.toolId === id ? { ...it, ...patch } : it)));
  }, []);

  // --- Engine event subscription -------------------------------------------
  useEffect(() => {
    const off = engine.on((ev) => {
      switch (ev.type) {
        case EVENTS.TOKEN:
          setStream((s) => ({ text: (s?.text || '') + ev.text, thinking: false, startedAt: s?.startedAt || Date.now() }));
          break;
        case EVENTS.REASONING:
          setStream((s) => (s ? s : { text: '', thinking: true, startedAt: Date.now() }));
          break;
        case EVENTS.ASSISTANT_DONE:
          setStream(null);
          if (ev.text && ev.text.trim()) {
            push({ kind: 'msg', who: 'term', text: ev.text.trim(), reasoning: ev.reasoning, thoughtMs: ev.reasoning ? ev.ms : null });
          }
          break;
        case EVENTS.TOOL_PROPOSED:
          setStream(null);
          // create (or update) a tool card item
          setItems((cur) => {
            const existing = cur.find((it) => it.toolId === ev.id);
            const data = {
              kind: 'tool', toolId: ev.id, name: ev.name, args: ev.args,
              danger: ev.gate?.danger || null, status: 'proposed',
            };
            if (existing) return cur.map((it) => (it.toolId === ev.id ? { ...it, ...data } : it));
            return appendItems(cur, [{ _k: uid(), ...data }]);
          });
          break;
        case EVENTS.TOOL_AWAIT:
          setSelected(0);
          setItems((cur) => {
            const it = cur.find((x) => x.toolId === ev.id);
            if (it) setPending({ id: ev.id, name: it.name, args: it.args, danger: it.danger });
            return cur;
          });
          break;
        case EVENTS.TOOL_RUNNING:
          setPending(null);
          outputBuffers.current[ev.id] = ''; // holds a partial (unterminated) line
          setLastOutputAt(Date.now()); // reset the "silent for Ns" timer
          patchItem(ev.id, { status: 'running', startedAt: Date.now() });
          break;
        case EVENTS.TOOL_OUTPUT: {
          // Stream output as complete LINES into the transcript. Each line is a
          // transcript item, so it shows live and scrolls with the in-app
          // viewport (alt-screen → no native scrollback).
          const buf = (outputBuffers.current[ev.id] || '') + ev.chunk;
          const parts = buf.split('\n');
          const partial = parts.pop(); // last piece may be an incomplete line
          outputBuffers.current[ev.id] = partial;
          if (parts.length) {
            setLastOutputAt(Date.now()); // we got fresh output → not silent
            setItems((cur) => appendItems(cur, parts.map((line) => ({ _k: uid(), kind: 'output', text: line }))));
          }
          break;
        }
        case EVENTS.TOOL_DONE: {
          // flush any trailing partial line, then a status line
          const partial = outputBuffers.current[ev.id];
          delete outputBuffers.current[ev.id]; // release the per-tool buffer (was retained forever)
          setItems((cur) => {
            const add = [];
            if (partial && partial.length) add.push({ _k: uid(), kind: 'output', text: partial });
            add.push({ _k: uid(), kind: 'tooldone', exitCode: ev.meta?.exitCode, interrupted: ev.meta?.interrupted });
            return appendItems(cur, add);
          });
          patchItem(ev.id, { status: 'done' });
          break;
        }
        case EVENTS.TURN_DONE:
          setStream(null);
          setStatus(null);
          // drain a queued message (typed while busy) -> send it as the next turn
          if (queueRef.current.length > 0) {
            const next = queueRef.current[0];
            queueRef.current = queueRef.current.slice(1);
            setQueue((q) => q.slice(1));
            push({ kind: 'msg', who: 'you', text: next });
            setBusyAt(Date.now());
            // keep busy=true; send the next turn immediately
            setTimeout(() => engine.send(next), 0);
          } else {
            setBusy(false);
            setBusyAt(null);
          }
          break;
        case EVENTS.ERROR:
          setStream(null);
          push({ kind: 'error', message: ev.message });
          if (ev.kind === 'connection') {
            push({ kind: 'notice', text: `endpoint: ${config.llm.endpoint} — start LM Studio or run /model to check`, level: 'dim' });
          }
          break;
        case EVENTS.NOTICE:
          push({ kind: 'notice', text: ev.text, level: ev.level });
          break;
        case EVENTS.STATUS:
          setStatus(ev.text);
          break;
        default:
          break;
      }
    });
    return off;
  }, [engine, push, patchItem, config.llm.endpoint]);

  // Suspend termita and hand the REAL terminal to a full-screen program (vim,
  // htop, tail -f, a REPL, or anything forced with `!!`). We leave the alt-screen,
  // drop mouse capture, restore cooked input, let the child own the terminal
  // (fully interactive), then re-enter the alt-screen and repaint when it exits.
  // Only full-screen TUIs come here — plain commands run INSIDE termita (see
  // runBangShell) so their output lands in the transcript, not a screen flash.
  const suspendRunner = useCallback(async (cmd, opts) => {
    // 1) release termita's grip on the terminal
    try { stdout.write('\x1b[?1006l\x1b[?1002l'); } catch { /* mouse off */ }
    try { stdout.write('\x1b[?1049l'); } catch { /* leave alt-screen */ }
    try { stdout.write('\x1b[2J\x1b[H'); } catch { /* clear the normal buffer */ }
    try { if (typeof setRawMode === 'function') setRawMode(false); } catch { /* cooked */ }
    if (stdin?.isPaused && !stdin.isPaused()) { try { stdin.pause(); } catch { /* ok */ } }

    let res = {};
    try {
      res = await runDirectProcess(cmd, { ...opts, tty: true });
    } finally {
      // 2) reclaim the terminal and force a full repaint of our UI
      try { if (typeof setRawMode === 'function') setRawMode(true); } catch { /* raw */ }
      try { stdin?.resume?.(); } catch { /* ok */ }
      try { stdout.write('\x1b[?1049h'); } catch { /* re-enter alt-screen */ }
      if (mouseCaptureRef.current) { try { stdout.write('\x1b[?1002h\x1b[?1006h'); } catch { /* mouse on */ } }
      try { stdout.write('\x1b[2J\x1b[H'); } catch { /* clear */ }
      setRepaint((n) => n + 1); // nudge Ink to redraw the whole tree
    }
    return res;
  }, [stdout, stdin, setRawMode]);

  // --- Submit a user line ---------------------------------------------------
  const submit = useCallback(async (raw) => {
    const text = raw.trim();
    setInput('');

    // A `!cmd` share is staged: this line is the user's comment on it (which MAY
    // be empty — Enter alone shares the staged context with no note). Handle it
    // BEFORE the empty-guard so a bare Enter still sends. (#direct)
    // A `!cmd` share is staged and awaiting a note. If this line is itself a
    // `!command` or `/slash`, the user has moved on — drop the pending share
    // (they didn't comment on it) and let the new command run below. Otherwise
    // the line is the note (empty = share the staged context alone). (#direct)
    if (pendingShare && !text.startsWith('!') && !text.startsWith('/')) {
      const share = pendingShare;
      setPendingShare(null);
      const content = text ? `${share.context}\n\nMy note: ${text}` : share.context;
      push({ kind: 'msg', who: 'you', text: text || `(shared: !${share.cmd})` });
      setBusy(true);
      setBusyAt(Date.now());
      engine.send(content);
      return;
    }
    if (pendingShare) setPendingShare(null); // moved on to a command — discard the stage

    if (!text) return;

    // `!cmd` — run a command yourself (no model, no approval). Two paths:
    //  · plain command → runs INSIDE termita, output streams into the transcript,
    //    then an in-app share menu (enter/f/e) picks what the model hears.
    //  · full-screen TUI (vim, htop, tail -f) or `!!cmd` → suspend + hand off the
    //    real terminal; nothing to capture, so it stages the command straight away.
    // Recalled verbatim with ↑ like any input. (#direct)
    if (text.startsWith('!') && text.length > 1) {
      const forceTty = text.startsWith('!!');
      const cmd = text.slice(forceTty ? 2 : 1).trim();
      if (!cmd) return;
      inputHistory.current.unshift(text);
      histIdx.current = -1;
      if (busy) { push({ kind: 'notice', text: 'busy — wait for the current turn (esc to stop), then run your `!` command', level: 'warn' }); return; }
      setBusy(true);
      setBusyAt(Date.now());
      if (forceTty || isInteractive(cmd)) {
        // full-screen program → suspend, hand off, stage the command
        const { staged } = await engine.runBangTty(cmd, { suspendRunner });
        if (staged) setPendingShare({ cmd, context: staged });
      } else {
        // plain command → run in-app, then open the share menu on its output
        const res = await engine.runBangShell(cmd);
        if (res) setShareMenu({ cmd, output: res.output, outFile: res.outFile, exitCode: res.exitCode, sel: 0 });
      }
      return;
    }

    inputHistory.current.unshift(text);
    histIdx.current = -1;

    // While the model/turn is busy, queue plain messages — they auto-send in
    // order when the current turn ends (so the model never loses them).
    if (busy && !text.startsWith('/')) {
      setQueue((q) => [...q, text]);
      return;
    }

    if (text.startsWith('/')) {
      await runSlash(text, {
        engine, config, provider,
        push,
        clearTranscript: () => { setItems([]); setStream(null); },
        toggleAuto: () => doToggleAuto(),
        setReasoning: (v) => doSetReasoning(v),
        setModel: (m) => doSetModel(m),
        openModelPicker: () => openModelPicker(),
        setMaxTokens: (n) => doSetMaxTokens(n),
        setContextSize: (n) => doSetContextSize(n),
        toggleMouse: (v) => doToggleMouse(v),
        toggleCognito: (v) => doToggleCognito(v),
        memoryChanged: () => engine.rebuildSystemPrompt(),
        showHelp: () => push({ kind: 'help' }),
        openSetup: () => setSetupOpen(true),
        quit: () => exit(),
        setStatus,
      });
      return;
    }

    push({ kind: 'msg', who: 'you', text });
    setBusy(true);
    setBusyAt(Date.now());
    engine.send(text);
  }, [engine, config, provider, push, exit, busy, suspendRunner, pendingShare]);

  const doToggleAuto = useCallback(() => {
    setAutoApprove((cur) => {
      const next = !cur;
      engine.gate.setAutoApprove(next);
      config.policy.autoApprove = next;
      saveConfig(config);
      push({ kind: 'notice', text: next ? `auto-approve ON ${glyphs.bolt} (danger still prompts)` : 'auto-approve OFF', level: next ? 'warn' : 'dim' });
      return next;
    });
  }, [engine, config, push]);

  const doSetReasoning = useCallback((v) => {
    setReasoning(v);
    config.llm.reasoning = v;
    provider.llm.reasoning = v;
    saveConfig(config);
    push({ kind: 'notice', text: `reasoning ${v ? 'on' : 'off'}`, level: 'dim' });
  }, [config, provider, push]);

  const doSetMaxTokens = useCallback((n) => {
    config.llm.maxTokens = n;
    provider.llm.maxTokens = n; // live: providers read this at request time
    saveConfig(config);
    push({ kind: 'notice', text: `maxTokens → ${n}`, level: 'ok' });
  }, [config, provider, push]);

  // Set the context-window size used by the footer gauge. `announce` is false for
  // the silent startup auto-detect (no notice line), true for the /context command.
  const doSetContextSize = useCallback((n, announce = true) => {
    config.llm.contextSize = n;
    saveConfig(config);
    setContextSize(n);
    if (announce) push({ kind: 'notice', text: `context window → ${n.toLocaleString()} tokens`, level: 'ok' });
  }, [config, push]);

  // Toggle mouse capture: ON = wheel scrolls the transcript; OFF = native
  // drag-to-select / copy-paste (wheel falls back to terminal scrollback).
  const doToggleMouse = useCallback((force) => {
    setMouseCapture((cur) => {
      const next = typeof force === 'boolean' ? force : !cur;
      if (!config.ui) config.ui = {};
      config.ui.mouseCapture = next;
      saveConfig(config);
      push({ kind: 'notice', text: next
        ? 'mouse capture ON — wheel scrolls (hold Option/Shift to select text)'
        : 'mouse capture OFF — drag to select / copy-paste (wheel uses terminal scrollback)',
        level: 'ok' });
      return next;
    });
  }, [config, push]);

  // Toggle incognito (memory blackout, session-only). Flips the memory module's
  // session flag, mirrors it to React state (footer indicator), and rebuilds the
  // system prompt so recall turns off/on immediately.
  const doToggleCognito = useCallback((force) => {
    setCognito((cur) => {
      const next = typeof force === 'boolean' ? force : !cur;
      memSetCognito(next);
      engine.rebuildSystemPrompt();
      push({ kind: 'notice', text: next
        ? '🕶️  incognito ON — nothing saved or recalled from memory this session'
        : 'incognito OFF — memory active again',
        level: next ? 'warn' : 'ok' });
      return next;
    });
  }, [engine, push]);

  // On startup, ask the server what context length the model actually has loaded
  // and adopt it — so the gauge isn't stuck at the 8k default when LM Studio is
  // configured for more. Only overrides when detection differs; never throws.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof provider.detectContextLength !== 'function') return;
        const n = await provider.detectContextLength(config.llm.model);
        if (!cancelled && n && n !== (config.llm.contextSize || 8192)) doSetContextSize(n, false);
      } catch { /* best-effort; keep the configured value */ }
    })();
    return () => { cancelled = true; };
  }, [provider, config, doSetContextSize]);

  const doSetModel = useCallback((m) => {
    setModel(m);
    config.llm.model = m;
    provider.llm.model = m; // live: providers read this at request time
    saveConfig(config);
    push({ kind: 'notice', text: `model → ${m}`, level: 'ok' });
  }, [config, provider, push]);

  // /model with no arg: fetch the model list and open the arrow-key picker.
  const openModelPicker = useCallback(async () => {
    push({ kind: 'notice', text: 'fetching models…', level: 'dim' });
    try {
      const models = await provider.listModels();
      if (!models.length) { push({ kind: 'notice', text: 'no models returned', level: 'warn' }); return; }
      const cur = models.indexOf(config.llm.model);
      setPicker({ models, sel: cur >= 0 ? cur : 0 });
    } catch (err) {
      push({ kind: 'error', message: err.message });
    }
  }, [provider, config, push]);

  // Onboarding wizard finished -> merge llm settings, swap the live provider.
  const onSetupDone = useCallback((llm) => {
    Object.assign(config.llm, llm);
    saveConfig(config);
    // rebuild the provider in case the provider TYPE changed (compat->anthropic)
    engine.swapProvider(config.llm);
    setModel(config.llm.model);
    setSetupOpen(false);
    push({ kind: 'notice', text: `set up ${config.llm.provider} · ${config.llm.model} — ready`, level: 'ok' });
  }, [config, engine, push]);

  const onSetupCancel = useCallback(() => {
    setSetupOpen(false);
    if (!config.llm.model) {
      push({ kind: 'notice', text: 'setup skipped — run /setup anytime to configure a model', level: 'warn' });
    }
  }, [config, push]);

  // --- Escape: interrupt if busy, else double-Esc opens rewind ---------------
  // Reads state through REFS, not captured values: this callback is captured by
  // PromptInput's useInput at mount and never re-subscribed, so closing over
  // `busy`/`stream`/`pending` directly would read stale (false) and Esc would
  // fail to interrupt a running command. Deps are stable ([engine, push]) so the
  // identity never churns either. (#esc)
  const handleEscape = useCallback(() => {
    if (setupRef.current) return;

    // Coalesce same-tick duplicate Esc events into one (see escBurst above).
    // A single physical press dispatches to several useInput handlers back-to-
    // back (and a straggler Esc byte can trail by a few ms); only the first
    // should drive the state machine. 60ms covers one dispatch burst while
    // staying far below any human double-tap (~120ms+ apart). This is also what
    // stops a just-opened rewind picker from blinking shut on the same press.
    const t = Date.now();
    if (t - escBurst.current < 60) return;
    escBurst.current = t;

    if (rewindRef.current) { setRewind(null); return; } // esc out of rewind mode

    // Single Esc while busy / streaming / a tool is running -> interrupt now.
    if (busyRef.current || streamRef.current || pendingRef.current) {
      engine.interrupt();
      setStatus(null);
      setStream(null);
      setPending(null);
      setBusy(false);
      setBusyAt(null);
      lastEsc.current = 0;
      return;
    }

    // Idle: detect double-Esc (two within 600ms) -> open jump-back picker.
    const now = Date.now();
    if (now - lastEsc.current < 600) {
      lastEsc.current = 0;
      const points = engine.history
        .map((m, idx) => ({ idx, text: m.role === 'user' ? m.content : null }))
        .filter((p) => p.text);
      if (points.length === 0) { push({ kind: 'notice', text: 'nothing to jump back to', level: 'dim' }); return; }
      setRewind({ points, sel: points.length - 1 });
    } else {
      lastEsc.current = now;
      setStatus('esc again to jump back');
      setTimeout(() => { setStatus((s) => (s === 'esc again to jump back' ? null : s)); }, 700);
    }
  }, [engine, push]);

  // keep the mouse-hook's Esc safety net pointed at the latest handleEscape
  useEffect(() => { handleEscapeRef.current = handleEscape; }, [handleEscape]);

  // Apply a rewind: truncate engine history + transcript to before the chosen msg.
  const applyRewind = useCallback((point) => {
    engine.rewindTo(point.idx);
    // rebuild transcript from the surviving history (drop everything after)
    setItems((cur) => {
      // find the Nth user message in items and cut there
      let userSeen = -1;
      const cut = [];
      const targetUserOrdinal = engine.history.filter((m) => m.role === 'user').length; // after rewind
      for (const it of cur) {
        if (it.kind === 'msg' && it.who === 'you') {
          userSeen++;
          if (userSeen >= targetUserOrdinal) break;
        }
        cut.push(it);
      }
      return cut;
    });
    setRewind(null);
    setStream(null);
    setInput(point.text);
    push({ kind: 'notice', text: 'jumped back — edit & send, or type a new message', level: 'ok' });
  }, [engine, push]);

  // Resolve the in-app share menu shown after a plain `!cmd`. `choice` is
  // 'enter' (share command only), 'full' (command + output), or 'empty' (silent).
  // enter/full → stage the context and drop into the input to add a note; empty →
  // clean input, nothing shared. Handled by termita's own keys (no stdin fight).
  const resolveShareMenu = useCallback((choice) => {
    setShareMenu((m) => {
      if (!m) return null;
      const staged = engine.stageDirect(m.cmd, { choice, output: m.output, outFile: m.outFile, exitCode: m.exitCode });
      if (staged) setPendingShare({ cmd: m.cmd, context: staged });
      return null;
    });
  }, [engine]);

  // The three share-menu rows, in order (used for ↑↓ navigation + labels).
  const shareActions = shareMenu
    ? [
        { key: 'enter', label: 'tell termita you ran it (command only)' },
        ...(shareMenu.output && shareMenu.output.trim() ? [{ key: 'full', label: 'share command + output' }] : []),
        { key: 'empty', label: 'silent — tell termita nothing' },
      ]
    : [];

  // `/` autocomplete: which commands match what's being typed right now. Only
  // active when idle (not approving / editing / picking / busy). Declared here —
  // BEFORE the key handler — because useInput's Tab branch reads showCmdMenu.
  const cmdMatches = (!pending && !editing && !picker && !rewind && !shareMenu && !busy) ? matchCommands(input) : [];
  const showCmdMenu = cmdMatches.length > 0;
  const narrow = columns < 72; // compact the footer/hints on small terminals

  // --- Key handling: approval, edit, interrupt, tab, ctrl-c -----------------
  // Disabled while the setup wizard is open (it owns the keyboard).
  useInput((inputCh, key) => {
    // Transcript scroll (alt-screen has no native scrollback). Works in any
    // state so you can scroll while busy/streaming. PgUp/PgDn step by ~a page;
    // Home jumps to the top, End/PgDn-to-0 returns to the latest. `scrollUp` is
    // clamped to the item count in render; stepping past the end pins to bottom.
    // Scroll a near-full page (leave 1 row of overlap for orientation).
    const page = Math.max(1, (viewportRef.current || 10) - 1);
    if (key.pageUp) { scrollBy(page); return; }
    if (key.pageDown) { scrollBy(-page); return; }
    // Ctrl+↑ / Ctrl+↓ scroll too — a fallback for keyboards/layouts where PgUp/
    // PgDn need Fn or are grabbed by the terminal (e.g. some Konsole profiles).
    if (key.ctrl && key.upArrow) { scrollBy(3); return; }
    if (key.ctrl && key.downArrow) { scrollBy(-3); return; }
    // Home → oldest line (clamped so a viewport stays full, not a blank screen);
    // End → back to the latest (pinned to bottom).
    if (key.home) { setScrollUp(maxScrollRef.current); return; }
    if (key.end) { setScrollUp(0); return; }

    // share menu (after a plain `!cmd`) owns the keyboard while open. ↑↓ navigate,
    // Enter picks the highlighted row, or hit the letter directly (f/e). Esc =
    // silent (same as choosing 'empty'). Handled here in termita's own key loop —
    // NOT by a raw stdin read — which is what fixes the flash-and-vanish bug.
    if (shareMenu) {
      const acts = shareActions;
      if (key.escape) { resolveShareMenu('empty'); return; }
      if (key.upArrow) { setShareMenu((m) => ({ ...m, sel: (m.sel - 1 + acts.length) % acts.length })); return; }
      if (key.downArrow) { setShareMenu((m) => ({ ...m, sel: (m.sel + 1) % acts.length })); return; }
      if (key.return) { resolveShareMenu(acts[shareMenu.sel]?.key || 'enter'); return; }
      const k = inputCh?.toLowerCase();
      if (k === 'f' && acts.some((a) => a.key === 'full')) { resolveShareMenu('full'); return; }
      if (k === 'e') { resolveShareMenu('empty'); return; }
      return;
    }

    // Edit mode handled by its own TextInput; ignore here
    if (editing) {
      if (key.escape) { setEditing(null); engine.resolveDecision({ kind: 'no' }); }
      return;
    }

    // rewind (jump-back) picker owns the keyboard while open. The selectable
    // range is points + one trailing "cancel" row (index === points.length),
    // so ↑↓ wrap through N+1 positions and Enter on the last one just closes.
    // Esc is routed through handleEscape (NOT closed here) so its burst guard
    // can absorb a straggler Esc byte from the SAME press that just opened the
    // picker — otherwise the picker blinks open then instantly closes. (#esc)
    if (rewind) {
      const slots = rewind.points.length + 1; // +1 for the cancel row
      if (key.escape) { handleEscape(); return; }
      if (key.upArrow) { setRewind((r) => ({ ...r, sel: (r.sel - 1 + slots) % slots })); return; }
      if (key.downArrow) { setRewind((r) => ({ ...r, sel: (r.sel + 1) % slots })); return; }
      if (key.return) {
        if (rewind.sel >= rewind.points.length) { setRewind(null); return; } // cancel row
        applyRewind(rewind.points[rewind.sel]);
        return;
      }
      return;
    }

    // interactive /model picker owns the keyboard while open
    if (picker) {
      if (key.escape) { setPicker(null); return; }
      if (key.upArrow) { setPicker((p) => ({ ...p, sel: (p.sel - 1 + p.models.length) % p.models.length })); return; }
      if (key.downArrow) { setPicker((p) => ({ ...p, sel: (p.sel + 1) % p.models.length })); return; }
      if (key.return) { const chosen = picker.models[picker.sel]; setPicker(null); doSetModel(chosen); return; }
      return;
    }

    // Tab toggles auto-approve — UNLESS the `/` command menu is open, where Tab
    // completes the highlighted command (handled in PromptInput). We recompute
    // the menu state inline from `input` (not the captured showCmdMenu) so a
    // stale closure can't let Tab BOTH toggle auto AND complete at once.
    if (key.tab) {
      if (matchCommands(input).length === 0) doToggleAuto();
      return;
    }

    if (key.escape) { handleEscape(); return; }

    if (key.ctrl && inputCh === 'c') {
      ctrlC.current += 1;
      if (ctrlC.current >= 2) exit();
      else { setStatus('press ctrl-c again to quit'); setTimeout(() => { ctrlC.current = 0; setStatus(null); }, 1500); }
      return;
    }

    // approval: arrow-navigated menu + R/E/A/N shortcuts
    if (pending) {
      if (key.upArrow) { setSelected((s) => (s - 1 + APPROVAL_ACTIONS.length) % APPROVAL_ACTIONS.length); return; }
      if (key.downArrow) { setSelected((s) => (s + 1) % APPROVAL_ACTIONS.length); return; }
      if (key.return) { chooseAction(APPROVAL_ACTIONS[selected].kind); return; }
      const k = inputCh?.toLowerCase();
      const hit = APPROVAL_ACTIONS.find((a) => a.key.toLowerCase() === k);
      if (hit) chooseAction(hit.kind);
      return;
    }
  }, { isActive: !setupOpen });

  // Run the chosen approval action (from key or Enter-on-highlight).
  const chooseAction = useCallback((kind) => {
    if (kind === 'edit') startEdit();
    else resolveApproval(kind);
  }, [selected, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveApproval = useCallback((kind) => {
    setPending(null);
    engine.resolveDecision({ kind });
  }, [engine]);

  const startEdit = useCallback(() => {
    if (!pending) return;
    const cmd = pending.name === 'shell' ? pending.args.command : pending.args.path;
    setEditing({ id: pending.id, value: cmd });
    setPending(null);
  }, [pending]);

  const submitEdit = useCallback((value) => {
    const e = editing;
    setEditing(null);
    engine.resolveDecision({ kind: 'edit', command: value });
  }, [editing, engine]);

  // input history navigation
  const onInputKey = useCallback((value, key) => {
    // handled inside TextInput onChange; arrow history handled separately below
  }, []);

  // --- Render ---------------------------------------------------------------
  // a tool is actively running — show a small "running" indicator with its own
  // timer in the live region below the transcript.
  const runningTool = items.find((it) => it.kind === 'tool' && it.status === 'running');
  const toolRunning = !!runningTool;

  // rough token estimate of the session (chars/4) + configurable context size
  // (state, so /context and startup auto-detect re-render the gauge live).
  const tokens = estimateTokens(engine.history);
  const ctxPct = Math.min(100, Math.round((tokens / contextSize) * 100));
  // colour the gauge by how full the window is: dim < 60% < amber < 85% < red
  const ctxColor = ctxPct >= 85 ? theme.danger : ctxPct >= 60 ? theme.warn : theme.dim;

  // Transcript items shown in the scroll viewport. Alt-screen has no native
  // scrollback, so the whole transcript is one in-app-scrolled region measured in
  // ROWS. We estimate each item's rendered height, sum it, and derive:
  //   viewport  = rows the transcript area can show (screen minus fixed chrome)
  //   maxScroll = total rows - viewport (how far up you can go; clamps Home)
  // then window the items so exactly the rows around the scroll offset render.
  // The Box below still uses overflow:hidden + flex-end to pixel-clip the edges,
  // but windowing by rows here is what makes the wheel move evenly and stops Home
  // from slicing the list empty (the old item-count math did — that was the bug).
  const allItems = items; // proposed/running/done all render the same in-band
  const rowsPerItem = allItems.map((it) => itemRows(it, columns));
  const totalRows = rowsPerItem.reduce((a, b) => a + b, 0) + BANNER_ROWS;
  // Fixed chrome below the transcript (input box + footer + a little slack). The
  // transcript viewport gets whatever's left of the screen height.
  const viewport = Math.max(3, rows - CHROME_ROWS);
  const maxScroll = Math.max(0, totalRows - viewport);
  const clampedScroll = Math.min(scrollUp, maxScroll);
  totalRowsRef.current = totalRows;
  viewportRef.current = viewport;
  maxScrollRef.current = maxScroll;

  // Walk items from the bottom, dropping `clampedScroll` rows off the end, then
  // keeping ~a viewport of rows above that. Over-include by a couple items so the
  // flex-end clip never shows a half-empty screen at the boundaries.
  const bottomDrop = clampedScroll;         // rows hidden below the viewport
  let acc = 0;
  let endIdx = allItems.length;             // exclusive; last item to show + 1
  for (let i = allItems.length - 1; i >= 0; i--) {
    if (acc >= bottomDrop) { endIdx = i + 1; break; }
    acc += rowsPerItem[i];
    if (i === 0) endIdx = 0;
  }
  // fill a viewport's worth of rows above endIdx
  let need = viewport + 2;
  let startIdx = endIdx;
  for (let i = endIdx - 1; i >= 0 && need > 0; i--) { need -= rowsPerItem[i]; startIdx = i; }
  const shownItems = allItems.slice(startIdx, endIdx);
  const atBottom = clampedScroll === 0;

  return (
    <Box key={`app-${repaint}`} flexDirection="column" paddingX={1} height={rows}>
      {/* Transcript viewport: flexGrow takes whatever height the live region
          below doesn't use; overflowY:hidden + justifyContent:flex-end clip to
          the latest content (pinned to bottom). Alt-screen repaints the whole
          buffer each frame, so resize can't strand ghosts here. */}
      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0}>
          {/* Banner only when the oldest content is in view — otherwise it would
              wrongly pin to the top of every scrolled-into-the-middle window. */}
          {startIdx === 0 && <Banner version={VERSION} firstRun={needsSetup} columns={columns} />}
          {shownItems.map((it) => (
            <TranscriptItem key={it._k} item={it} width={columns} />
          ))}
          {/* live streaming assistant rides at the bottom of the transcript */}
          {atBottom && stream && <StreamingMessage text={stream.text} thinking={stream.thinking && !stream.text} startedAt={stream.startedAt} />}
        </Box>
      </Box>

      {/* Bottom chrome (indicators, overlays, input, footer). flexShrink={0} so
          it ALWAYS gets its full height — only the transcript viewport above
          shrinks. Without this the greedy transcript squeezes the input box off
          the bottom of the screen when the transcript overflows. */}
      <Box flexDirection="column" flexShrink={0}>
      {/* scroll indicator when not pinned to the bottom */}
      {!atBottom && (
        <Box paddingLeft={1}>
          <Text color={theme.faint}>
            ↑ scrolled up{startIdx === 0 ? ' · top' : ` ${clampedScroll} rows`} · wheel / PgDn / ctrl+↓ / End for latest
          </Text>
        </Box>
      )}

      {/* approval bar for the pending tool */}
      {pending && <ApprovalMenu selected={selected} danger={!!pending.danger} />}

      {/* share menu after a plain `!cmd`: its output is already in the transcript
          above — pick what the model hears. In-app, so no stdin fight. */}
      {shareMenu ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
          <Text color={theme.brand} bold>
            {glyphs.bullet} !{shareMenu.cmd.length > 40 ? shareMenu.cmd.slice(0, 39) + '…' : shareMenu.cmd} finished
            {shareMenu.exitCode != null && shareMenu.exitCode !== 0 ? <Text color={theme.danger}> (exit {shareMenu.exitCode})</Text> : ''}
            <Text color={theme.faint}> — share with termita?</Text>
          </Text>
          {shareActions.map((a, i) => (
            <Text key={a.key} color={i === shareMenu.sel ? theme.ok : theme.dim} bold={i === shareMenu.sel}>
              {i === shareMenu.sel ? glyphs.bullet : ' '} {a.label}
            </Text>
          ))}
          <Text color={theme.faint}>  ↑↓ select · enter · f share+output · e silent</Text>
        </Box>
      ) : rewind ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
          <Text color={theme.brand} bold>↩ jump back to…</Text>
          {rewind.points.map((p, i) => (
            <Text key={p.idx} color={i === rewind.sel ? theme.ok : theme.dim} bold={i === rewind.sel}>
              {i === rewind.sel ? glyphs.bullet : ' '} {p.text.length > 64 ? p.text.slice(0, 64) + '…' : p.text}
            </Text>
          ))}
          {/* explicit cancel row: sel === points.length means "stay put". Arrow
              to it + Enter, or just hit Esc — both close without rewinding. */}
          <Text color={rewind.sel === rewind.points.length ? theme.warn : theme.dim} bold={rewind.sel === rewind.points.length}>
            {rewind.sel === rewind.points.length ? glyphs.bullet : ' '} cancel — keep going where I am
          </Text>
          <Text color={theme.faint}>  ↑↓ select · enter · esc cancel</Text>
        </Box>
      ) : picker ? (
        /* interactive /model picker: arrow-select a model, no typing the id */
        <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
          <Text color={theme.brand} bold>{glyphs.bullet} pick a model</Text>
          {visiblePicker(picker, columns).map(({ id, i }) => (
            <Text key={id} color={i === picker.sel ? theme.ok : theme.dim} bold={i === picker.sel}>
              {i === picker.sel ? glyphs.bullet : ' '} {id === config.llm.model ? glyphs.check + ' ' : '  '}{clampText(id, columns - 8)}
            </Text>
          ))}
          <Text color={theme.faint}>  ↑↓ select · enter switch · esc cancel  {picker.models.length > PICKER_WINDOW ? `(${picker.sel + 1}/${picker.models.length})` : ''}</Text>
        </Box>
      ) : setupOpen ? (
        /* onboarding wizard takes over the input region when open */
        <Setup initial={config.llm} onDone={onSetupDone} onCancel={onSetupCancel} />
      ) : (
        <>
          {/* live indicators: a running command, OR the model thinking (not both).
              Output itself streams into scrollback above as 'output' lines. The
              running indicator shows WHICH command is running + a "silent for Ns"
              nudge, so a long/quiet command never looks like termita froze. */}
          {runningTool && (
            <RunningIndicator tool={runningTool} lastOutputAt={lastOutputAt} width={columns} />
          )}
          {busy && !toolRunning && !stream && !pending && !editing && (
            <Box paddingLeft={2}>
              <Spinner label={status || 'thinking'} />
              <Text color={theme.faint}> </Text>
              {busyAt ? <ElapsedInline since={busyAt} /> : null}
            </Box>
          )}

          {/* queued messages (typed while busy) — sent in order when free */}
          {queue.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {queue.map((q, i) => (
                <Text key={i} color={theme.faint}>⤷ queued: {q.length > 60 ? q.slice(0, 60) + '…' : q}</Text>
              ))}
            </Box>
          )}

          {/* `/` command autocomplete — floats above the input while typing */}
          {showCmdMenu && <CommandMenu matches={cmdMatches} selected={cmdSel} width={columns} />}

          {/* a `!cmd` result is staged to share — this line becomes your note on it */}
          {pendingShare && (
            <Box paddingLeft={1}>
              <Text color={theme.brand}>{glyphs.bullet} sharing </Text>
              <Text color={theme.brandDim}>!{pendingShare.cmd}</Text>
              <Text color={theme.faint}> — add a note, or press enter to send as-is</Text>
            </Box>
          )}

          {/* input / edit prompt */}
          <Box
            borderStyle="round"
            borderColor={pending ? theme.faint : theme.brand}
            borderLeft={false}
            borderRight={false}
            paddingX={1}
            flexDirection="row"
            alignItems="flex-start"
          >
            {/* Marker sits top-left in its own fixed-width column; the input is a
                flex column beside it so multi-line text wraps cleanly BELOW the
                first line instead of shoving the box border around. */}
            {editing ? (
              <>
                <Box flexShrink={0}><Text color={theme.warn}>{glyphs.bolt} edit </Text></Box>
                <Box flexGrow={1}>
                  <TextInput value={editing.value} onChange={(v) => setEditing((e) => ({ ...e, value: v }))} onSubmit={submitEdit} />
                </Box>
              </>
            ) : (
              <>
                <Box flexShrink={0}><Text color={pending ? theme.faint : theme.brand} bold>{glyphs.prompt} </Text></Box>
                <Box flexGrow={1}>
                  <PromptInput
                    value={input}
                    onChange={setInput}
                    onSubmit={submit}
                    disabled={!!pending}
                    history={inputHistory}
                    histIdx={histIdx}
                    setInput={setInput}
                    onEscape={handleEscape}
                    cmdMatches={cmdMatches}
                    cmdSel={cmdSel}
                    setCmdSel={setCmdSel}
                  />
                </Box>
              </>
            )}
          </Box>

          {/* contextual cue while something is happening (approval / running /
              streaming). No idle hint — the input sits on its own clean line.
              Hidden when the command menu is open. */}
          {!showCmdMenu && (pending || toolRunning || busy) && (
            <Box paddingLeft={1}>
              <Text color={theme.faint}>
                {pending ? '↑↓ + enter · or R/E/A/N · esc cancels'
                  : toolRunning ? 'running… esc to stop'
                  : 'esc to interrupt'}
              </Text>
            </Box>
          )}

          {/* footer: mascot + version bottom-LEFT, status (auto · ctx · model)
              on the right. Wraps to two rows automatically on narrow widths. */}
          <Box paddingLeft={1} justifyContent="space-between" flexWrap="wrap">
            <MascotTag version={VERSION} />
            <Text>
              {cognito && <Text color={theme.warn} bold>🕶️ incognito </Text>}
              {autoApprove && <Text color={theme.warn} bold>AUTO-ACCEPT {glyphs.bolt} </Text>}
              {reasoning && <Text color={theme.faint}>{glyphs.thought} think </Text>}
              <Text color={ctxColor}>ctx {fmtTokens(tokens)}/{fmtTokens(contextSize)} {ctxPct}% </Text>
              <Text color={theme.brandDim}>{clampText(model, narrow ? 16 : 40)}</Text>
            </Text>
          </Box>
        </>
      )}
      </Box>
    </Box>
  );
}

// Wraps TextInput to add ↑/↓ history AND handle Esc. The <TextInput> is focused
// while typing, so the PARENT useInput never sees keys here — Esc and history
// must be handled in THIS component or they're swallowed by the text field.
function PromptInput({ value, onChange, onSubmit, disabled, history, histIdx, setInput, onEscape, cmdMatches = [], cmdSel = 0, setCmdSel }) {
  const menuOpen = cmdMatches.length > 0;
  const highlighted = () => cmdMatches[cmdSel] || cmdMatches[0];
  const complete = (cmd) => setInput('/' + cmd.name + ' '); // fill the command, leave room for args

  useInput((ch, key) => {
    // Esc must work even while "disabled" (a command is running) — that's the
    // whole point: interrupt the running command / streaming turn.
    if (key.escape) {
      // Esc with the command menu open just closes the menu (clears the `/`).
      if (menuOpen) { setInput(''); setCmdSel?.(0); return; }
      onEscape?.();
      return;
    }
    if (disabled) return;

    // `/` autocomplete dropdown owns ↑↓ + Tab + Enter while it's showing.
    if (menuOpen) {
      if (key.upArrow) { setCmdSel?.((s) => (s - 1 + cmdMatches.length) % cmdMatches.length); return; }
      if (key.downArrow) { setCmdSel?.((s) => (s + 1) % cmdMatches.length); return; }
      // Tab = COMPLETE into the input (so you can add args, e.g. /maxtokens 8192).
      if (key.tab) { complete(highlighted()); return; }
      // Enter = RUN the highlighted command immediately. We submit the explicit
      // `/name` string (not `value`) so it never depends on stale input state —
      // this is what makes one Enter actually fire /help, /clear, etc.
      if (key.return) { onSubmit('/' + highlighted().name); return; }
    }

    // Newline-without-submit. Three ways, by terminal capability:
    //  - Shift+Enter / Alt+Enter: works only in terminals that report the
    //    modifier (iTerm, kitty, Windows Terminal). Konsole/xterm do NOT —
    //    they send a bare \r identical to Enter, so key.shift is never set.
    //  - Ctrl+J: portable fallback. Ctrl+J is a literal line-feed (\n) that
    //    every terminal — Konsole included — passes through distinctly from
    //    Enter's \r, so Ink sees it here while Enter still submits.
    //  - trailing "\" on submit (handled in handleSubmit below).
    if (key.return && (key.shift || key.meta)) { onChange(value + '\n'); return; }
    if (key.ctrl && ch === 'j') { onChange(value + '\n'); return; }
    if (key.upArrow) {
      const h = history.current;
      if (h.length === 0) return;
      histIdx.current = Math.min(histIdx.current + 1, h.length - 1);
      setInput(h[histIdx.current]);
    } else if (key.downArrow) {
      const h = history.current;
      if (histIdx.current <= 0) { histIdx.current = -1; setInput(''); }
      else { histIdx.current -= 1; setInput(h[histIdx.current]); }
    }
  });

  // Trailing backslash = line continuation (portable fallback for shift+enter).
  const handleSubmit = (v) => {
    // When the `/` menu is open, Enter is OWNED by the useInput handler above
    // (it runs the highlighted command). <TextInput> also fires onSubmit on the
    // same keypress — swallow it here so the command doesn't run twice / with a
    // stale value. This is what fixed "double-enter does nothing / menu sticks".
    if (menuOpen) return;
    if (v.endsWith('\\')) { onChange(v.slice(0, -1) + '\n'); return; }
    onSubmit(v);
  };

  if (disabled) return <Text color={theme.faint}>{value || '(running… esc to stop)'}</Text>;
  // Wrap in an explicit whitish color so typed text doesn't inherit the
  // terminal's default foreground (which is green in some terminal themes).
  return (
    <Text color={theme.text}>
      <TextInput value={value} onChange={onChange} onSubmit={handleSubmit} />
    </Text>
  );
}

// Rough token estimate: ~4 chars/token across all message content.
function estimateTokens(history) {
  let chars = 0;
  for (const m of history || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.tool_calls) for (const tc of m.tool_calls) chars += (tc.function?.arguments || '').length;
  }
  return Math.ceil(chars / 4);
}

function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

// Clamp a string to `max` cols with an ellipsis (keeps long model ids / hints
// from overflowing a narrow terminal).
function clampText(s, max) {
  if (!s || max == null || max < 2) return s || '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// How many model rows the picker shows at once (scrolls a window for long lists).
const PICKER_WINDOW = 8;

// Windowed slice of the model list centred on the selection, with original
// indices preserved so highlighting still maps to picker.sel.
function visiblePicker(picker, columns) { // eslint-disable-line no-unused-vars
  const { models, sel } = picker;
  if (models.length <= PICKER_WINDOW) return models.map((id, i) => ({ id, i }));
  let start = Math.max(0, sel - Math.floor(PICKER_WINDOW / 2));
  start = Math.min(start, models.length - PICKER_WINDOW);
  return models.slice(start, start + PICKER_WINDOW).map((id, k) => ({ id, i: start + k }));
}

// Small ticking elapsed timer for the busy/thinking indicator.
function ElapsedInline({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <Text color={theme.faint}>{((now - since) / 1000).toFixed(1)}s</Text>;
}

// Live "what's running right now" block. Shows the actual command (so it's
// obviously alive, not frozen), elapsed time, and — if no output has arrived
// for a while — a "silent for Ns" nudge so a quiet long command reads as BUSY,
// not HUNG. Ticks on its own so the silent timer updates without engine events.
function RunningIndicator({ tool, lastOutputAt, width }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const cmd = tool.name === 'shell' ? tool.args?.command
    : tool.name === 'write' ? `write ${tool.args?.path}`
    : tool.name === 'websearch' ? `search: ${tool.args?.query}`
    : (tool.args?.path || tool.args?.pattern || tool.name);
  const oneLine = String(cmd || tool.name).replace(/\s+/g, ' ').trim();
  const silentMs = lastOutputAt ? now - lastOutputAt : 0;
  const silent = silentMs > 3000; // no new output for >3s → show a reassurance
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Spinner label="running" color={theme.brand} />
        <Text color={theme.faint}> </Text>
        {tool.startedAt ? <ElapsedInline since={tool.startedAt} /> : null}
        <Text color={theme.faint}> · esc to stop</Text>
      </Box>
      <Text color={theme.brandDim} wrap="truncate-end">  {glyphs.run} {clampText(oneLine, Math.max(20, (width || 80) - 6))}</Text>
      {silent && (
        <Text color={theme.faint} italic>  …no output for {Math.round(silentMs / 1000)}s — still working, esc to stop</Text>
      )}
    </Box>
  );
}

// Memoised: in alt-screen the whole transcript re-renders on every keystroke and
// on every live-region timer tick (spinner 80ms, elapsed 250ms). Without memo,
// each of those reconciles all ~600 items — that's the typing lag. Item objects
// are stable references (created once, only patched when a tool's status
// changes), so React.memo skips every item whose props didn't actually change;
// a keystroke then only re-renders the input + live region. (see #perf)
const TranscriptItem = React.memo(function TranscriptItem({ item, width }) {
  switch (item.kind) {
    case 'msg':
      return <Message who={item.who} text={item.text} reasoning={item.reasoning} thoughtMs={item.thoughtMs} width={width} />;
    case 'tool':
      // just the proposal card; output streams below as separate 'output' items
      return <ToolCard name={item.name} args={item.args} danger={item.danger} status={item.status} />;
    case 'output':
      // one line of shell output — dim, indented, prints into scrollback live
      return <Text color={theme.dim} wrap="wrap">  │ {item.text || ' '}</Text>;
    case 'tooldone': {
      const color = item.interrupted ? theme.warn : (item.exitCode === 0 || item.exitCode == null) ? theme.okDim : theme.danger;
      const label = item.interrupted ? '⊘ interrupted' : (item.exitCode === 0 || item.exitCode == null) ? '✓ done' : `✗ exit ${item.exitCode}`;
      return <Text color={color} bold>  {label}</Text>;
    }
    case 'notice':
      return <Notice text={item.text} level={item.level} />;
    case 'error':
      return <ErrorBox message={item.message} />;
    case 'trim':
      return (
        <Text color={theme.faint} italic>
          {'  '}↑ {item.count} earlier lines trimmed from view (full output saved on disk)
        </Text>
      );
    case 'help':
      return <HelpPanel />;
    default:
      return null;
  }
});
