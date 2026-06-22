// Ink root. Renders the transcript, captures input + approval keys + slash
// commands, subscribes to engine events. The engine is UI-agnostic; this is the
// only place that knows about both.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { EVENTS } from './engine/events.js';
import { theme, glyphs } from './ui/theme.js';
import { Banner, HelpPanel } from './ui/banner.jsx';
import {
  Message, StreamingMessage, ToolCard, OutputStream, ApprovalMenu, APPROVAL_ACTIONS, Notice, ErrorBox, Spinner,
} from './ui/components.jsx';
import { saveConfig } from './config/config.js';
import { runSlash } from './slash.js';
import Setup from './ui/setup.jsx';

let _id = 0;
const uid = () => `i${++_id}`;

export default function App({ engine, config, provider, needsSetup }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

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
  const [showBanner, setShowBanner] = useState(true);
  const [autoApprove, setAutoApprove] = useState(config.policy.autoApprove);
  const [reasoning, setReasoning] = useState(config.llm.reasoning);
  const [model, setModel] = useState(config.llm.model);
  const [status, setStatus] = useState(null);

  const [rewind, setRewind] = useState(null); // { points:[{idx,text}], sel } when in jump-back mode

  const inputHistory = useRef([]);
  const histIdx = useRef(-1);
  const ctrlC = useRef(0);
  const lastEsc = useRef(0); // timestamp of last Esc, for double-Esc detection
  const outputBuffers = useRef({}); // id -> accumulated live output
  const queueRef = useRef([]); // mirror of `queue` for the engine event closure

  const push = useCallback((item) => setItems((cur) => [...cur, { _k: uid(), ...item }]), []);

  // keep queueRef in sync so the engine event closure can read the latest queue
  useEffect(() => { queueRef.current = queue; }, [queue]);

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
            return [...cur, { _k: uid(), ...data }];
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
          patchItem(ev.id, { status: 'running', startedAt: Date.now() });
          break;
        case EVENTS.TOOL_OUTPUT: {
          // Stream output as complete LINES into the transcript (→ Static →
          // terminal scrollback). Each line prints immediately and stays, so it
          // streams live AND scrolls natively, no fixed box to clip it.
          const buf = (outputBuffers.current[ev.id] || '') + ev.chunk;
          const parts = buf.split('\n');
          const partial = parts.pop(); // last piece may be an incomplete line
          outputBuffers.current[ev.id] = partial;
          if (parts.length) {
            setItems((cur) => [...cur, ...parts.map((line) => ({ _k: uid(), kind: 'output', text: line }))]);
          }
          break;
        }
        case EVENTS.TOOL_DONE: {
          // flush any trailing partial line, then a status line
          const partial = outputBuffers.current[ev.id];
          outputBuffers.current[ev.id] = '';
          setItems((cur) => {
            const add = [];
            if (partial && partial.length) add.push({ _k: uid(), kind: 'output', text: partial });
            add.push({ _k: uid(), kind: 'tooldone', exitCode: ev.meta?.exitCode, interrupted: ev.meta?.interrupted });
            return [...cur, ...add];
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

  // --- Submit a user line ---------------------------------------------------
  const submit = useCallback(async (raw) => {
    const text = raw.trim();
    setInput('');
    if (!text) return;
    setShowBanner(false);
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
        setModel: (m) => { setModel(m); config.llm.model = m; saveConfig(config); },
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
  }, [engine, config, provider, push, exit, busy]);

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

  // Onboarding wizard finished -> merge llm settings, swap the live provider.
  const onSetupDone = useCallback((llm) => {
    Object.assign(config.llm, llm);
    saveConfig(config);
    // rebuild the provider in case the provider TYPE changed (compat->anthropic)
    engine.swapProvider(config.llm);
    setModel(config.llm.model);
    setSetupOpen(false);
    setShowBanner(false);
    push({ kind: 'notice', text: `set up ${config.llm.provider} · ${config.llm.model} — ready`, level: 'ok' });
  }, [config, engine, push]);

  const onSetupCancel = useCallback(() => {
    setSetupOpen(false);
    if (!config.llm.model) {
      push({ kind: 'notice', text: 'setup skipped — run /setup anytime to configure a model', level: 'warn' });
    }
  }, [config, push]);

  // --- Escape: interrupt if busy, else double-Esc opens rewind ---------------
  const handleEscape = useCallback(() => {
    if (setupOpen) return;
    if (rewind) { setRewind(null); return; } // esc out of rewind mode

    // Single Esc while busy / streaming / a tool is running -> interrupt now.
    if (busy || stream || pending) {
      engine.interrupt();
      setStatus(null);
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
  }, [setupOpen, rewind, busy, stream, pending, engine, push]);

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

  // --- Key handling: approval, edit, interrupt, tab, ctrl-c -----------------
  // Disabled while the setup wizard is open (it owns the keyboard).
  useInput((inputCh, key) => {
    // Edit mode handled by its own TextInput; ignore here
    if (editing) {
      if (key.escape) { setEditing(null); engine.resolveDecision({ kind: 'no' }); }
      return;
    }

    // rewind (jump-back) picker owns the keyboard while open
    if (rewind) {
      if (key.escape) { setRewind(null); return; }
      if (key.upArrow) { setRewind((r) => ({ ...r, sel: (r.sel - 1 + r.points.length) % r.points.length })); return; }
      if (key.downArrow) { setRewind((r) => ({ ...r, sel: (r.sel + 1) % r.points.length })); return; }
      if (key.return) { applyRewind(rewind.points[rewind.sel]); return; }
      return;
    }

    if (key.tab) { doToggleAuto(); return; }

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
  // Split the transcript: SETTLED items go into <Static> (rendered ONCE, never
  // redrawn — this is what kills the per-keystroke flicker). Only LIVE items (a
  // tool still proposed/running) and the input region re-render on each key.
  // A tool card settles into Static as soon as it's running/done (the card
  // itself never changes after that; output streams as separate Static lines
  // below it). Only a tool still awaiting approval ('proposed') stays live.
  const isSettled = (it) => it.kind !== 'tool' || it.status !== 'proposed';
  const settled = items.filter(isSettled);
  const live = items.filter((it) => !isSettled(it));
  // a tool is actively running (output streams as Static lines; show a small
  // "running" indicator in the live region with its own timer)
  const runningTool = items.find((it) => it.kind === 'tool' && it.status === 'running');
  const toolRunning = !!runningTool;

  // rough token estimate of the session (chars/4) + configurable context size
  const tokens = estimateTokens(engine.history);
  const contextSize = config.llm.contextSize || 8192;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Everything settled is printed ONCE via <Static> — Ink writes it to the
          terminal permanently and never redraws it. The banner+header ride along
          as the first static items. This is what stops the whole-screen flicker:
          only the small dynamic region below re-renders on keystrokes/spinner. */}
      <Static items={[...(showBanner ? [{ _k: '__banner__' }] : []), ...settled]}>
        {(it) => (it._k === '__banner__' ? <Banner key="__banner__" /> : <TranscriptItem key={it._k} item={it} />)}
      </Static>

      {/* live (in-flight) transcript items re-render here */}
      {live.map((it) => (
        <TranscriptItem key={it._k} item={it} />
      ))}

      {/* live streaming assistant */}
      {stream && <StreamingMessage text={stream.text} thinking={stream.thinking && !stream.text} startedAt={stream.startedAt} />}

      {/* approval bar for the pending tool */}
      {pending && <ApprovalMenu selected={selected} danger={!!pending.danger} />}

      {/* rewind picker (double-Esc): jump back to an earlier message */}
      {rewind ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
          <Text color={theme.accent} bold>↩ jump back to…</Text>
          {rewind.points.map((p, i) => (
            <Text key={p.idx} color={i === rewind.sel ? theme.ok : theme.dim} bold={i === rewind.sel}>
              {i === rewind.sel ? glyphs.bullet : ' '} {p.text.length > 64 ? p.text.slice(0, 64) + '…' : p.text}
            </Text>
          ))}
          <Text color={theme.faint}>  ↑↓ select · enter rewind here · esc cancel</Text>
        </Box>
      ) : setupOpen ? (
        /* onboarding wizard takes over the input region when open */
        <Setup initial={config.llm} onDone={onSetupDone} onCancel={onSetupCancel} />
      ) : (
        <>
          {/* live indicators: a running command, OR the model thinking (not both).
              Output itself streams into scrollback above as 'output' lines. */}
          {runningTool && (
            <Box paddingLeft={2}>
              <Spinner label="running" color={theme.brand} />
              <Text color={theme.faint}> </Text>
              {runningTool.startedAt ? <ElapsedInline since={runningTool.startedAt} /> : null}
              <Text color={theme.faint}> · esc to stop</Text>
            </Box>
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

          {/* input / edit prompt */}
          <Box>
            {editing ? (
              <>
                <Text color={theme.warn}>{glyphs.bolt} edit </Text>
                <TextInput value={editing.value} onChange={(v) => setEditing((e) => ({ ...e, value: v }))} onSubmit={submitEdit} />
              </>
            ) : (
              <>
                <Text color={pending ? theme.faint : theme.accent} bold>{glyphs.prompt} </Text>
                <PromptInput
                  value={input}
                  onChange={setInput}
                  onSubmit={submit}
                  disabled={!!pending}
                  history={inputHistory}
                  histIdx={histIdx}
                  setInput={setInput}
                  onEscape={handleEscape}
                />
              </>
            )}
          </Box>

          {/* footer: hint on the left, AUTO legend · tokens · model on the right.
              No thinking spinner here — the term block above owns that, so we
              don't double it. */}
          <Box paddingLeft={1} justifyContent="space-between">
            <Text color={theme.faint}>
              {pending ? '↑↓ + enter · or R/E/A/N · esc cancels'
                : toolRunning ? 'running… esc to stop'
                : busy ? 'esc to interrupt'
                : '/help · /setup · tab auto-approve · esc esc to jump back'}
            </Text>
            <Text>
              {autoApprove && <Text color={theme.warn} bold>AUTO {glyphs.bolt} (tab off) </Text>}
              {reasoning && <Text color={theme.faint}>{glyphs.thought} think </Text>}
              <Text color={theme.dim}>{fmtTokens(tokens)}/{fmtTokens(contextSize)} </Text>
              <Text color={theme.brandDim}>{model}</Text>
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

// Wraps TextInput to add ↑/↓ history AND handle Esc. The <TextInput> is focused
// while typing, so the PARENT useInput never sees keys here — Esc and history
// must be handled in THIS component or they're swallowed by the text field.
function PromptInput({ value, onChange, onSubmit, disabled, history, histIdx, setInput, onEscape }) {
  useInput((ch, key) => {
    // Esc must work even while "disabled" (a command is running) — that's the
    // whole point: interrupt the running command / streaming turn.
    if (key.escape) { onEscape?.(); return; }
    if (disabled) return;
    // Shift+Enter (or Alt+Enter) inserts a newline instead of submitting.
    // Terminals that report the modifier get true multiline; others can also
    // type a trailing "\" to continue on the next line (handled in onSubmit).
    if (key.return && (key.shift || key.meta)) { onChange(value + '\n'); return; }
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
    if (v.endsWith('\\')) { onChange(v.slice(0, -1) + '\n'); return; }
    onSubmit(v);
  };

  if (disabled) return <Text color={theme.faint}>{value || '(running… esc to stop)'}</Text>;
  return <TextInput value={value} onChange={onChange} onSubmit={handleSubmit} placeholder="talk to termita…  (shift+enter or \ = newline)" />;
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

// Small ticking elapsed timer for the busy/thinking indicator.
function ElapsedInline({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <Text color={theme.faint}>{((now - since) / 1000).toFixed(1)}s</Text>;
}

function TranscriptItem({ item }) {
  switch (item.kind) {
    case 'msg':
      return <Message who={item.who} text={item.text} reasoning={item.reasoning} thoughtMs={item.thoughtMs} />;
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
    case 'help':
      return <HelpPanel />;
    default:
      return null;
  }
}
