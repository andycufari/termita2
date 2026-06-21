// Ink root. Renders the transcript, captures input + approval keys + slash
// commands, subscribes to engine events. The engine is UI-agnostic; this is the
// only place that knows about both.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { EVENTS } from './engine/events.js';
import { theme, glyphs } from './ui/theme.js';
import { Header, Banner, HelpPanel } from './ui/banner.jsx';
import {
  Message, StreamingMessage, ToolCard, OutputStream, ApprovalMenu, APPROVAL_ACTIONS, Notice, ErrorBox, Spinner,
} from './ui/components.jsx';
import { saveConfig } from './config/config.js';
import { runSlash } from './slash.js';

let _id = 0;
const uid = () => `i${++_id}`;

export default function App({ engine, config, provider }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [items, setItems] = useState([]); // transcript items
  const [input, setInput] = useState('');
  const [stream, setStream] = useState(null); // { text, thinking }
  const [pending, setPending] = useState(null); // active approval { id, name, args, gate }
  const [selected, setSelected] = useState(0); // highlighted approval action index
  const [editing, setEditing] = useState(null); // { id, value } when Editing a command
  const [busy, setBusy] = useState(false);
  const [busyAt, setBusyAt] = useState(null);
  const [showBanner, setShowBanner] = useState(true);
  const [autoApprove, setAutoApprove] = useState(config.policy.autoApprove);
  const [reasoning, setReasoning] = useState(config.llm.reasoning);
  const [model, setModel] = useState(config.llm.model);
  const [status, setStatus] = useState(null);

  const inputHistory = useRef([]);
  const histIdx = useRef(-1);
  const ctrlC = useRef(0);
  const outputBuffers = useRef({}); // id -> accumulated live output

  const push = useCallback((item) => setItems((cur) => [...cur, { _k: uid(), ...item }]), []);

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
          outputBuffers.current[ev.id] = '';
          patchItem(ev.id, { status: 'running', output: '', startedAt: Date.now() });
          break;
        case EVENTS.TOOL_OUTPUT: {
          const prev = outputBuffers.current[ev.id] || '';
          const next = prev + ev.chunk + (ev.chunk.endsWith('\n') ? '' : '\n');
          outputBuffers.current[ev.id] = next;
          patchItem(ev.id, { output: next });
          break;
        }
        case EVENTS.TOOL_DONE:
          patchItem(ev.id, {
            status: 'done', output: ev.output, exitCode: ev.meta?.exitCode,
            interrupted: ev.meta?.interrupted, hidden: ev.name === 'read' || ev.name === 'grep' ? false : false,
          });
          break;
        case EVENTS.TURN_DONE:
          setBusy(false);
          setBusyAt(null);
          setStream(null);
          setStatus(null);
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

    if (text.startsWith('/')) {
      await runSlash(text, {
        engine, config, provider,
        push,
        clearTranscript: () => { setItems([]); setStream(null); },
        toggleAuto: () => doToggleAuto(),
        setReasoning: (v) => doSetReasoning(v),
        setModel: (m) => { setModel(m); config.llm.model = m; saveConfig(config); },
        showHelp: () => push({ kind: 'help' }),
        quit: () => exit(),
        setStatus,
      });
      return;
    }

    push({ kind: 'msg', who: 'you', text });
    setBusy(true);
    setBusyAt(Date.now());
    engine.send(text);
  }, [engine, config, provider, push, exit]);

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

  // --- Key handling: approval, edit, interrupt, tab, ctrl-c -----------------
  useInput((inputCh, key) => {
    // Edit mode handled by its own TextInput; ignore here
    if (editing) {
      if (key.escape) { setEditing(null); engine.resolveDecision({ kind: 'no' }); }
      return;
    }

    if (key.tab) { doToggleAuto(); return; }

    if (key.escape) {
      if (busy || pending) { engine.interrupt(); setStatus(null); }
      return;
    }

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
  });

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
  const isSettled = (it) => it.kind !== 'tool' || it.status === 'done';
  const settled = items.filter(isSettled);
  const live = items.filter((it) => !isSettled(it));

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

      {/* busy spinner when waiting on first token (shows it's alive) */}
      {busy && !stream && !pending && !editing && (
        <Box paddingLeft={2}>
          <Spinner label={status || 'thinking…'} />
          {busyAt ? <Text color={theme.faint}>  </Text> : null}
          {busyAt ? <ElapsedInline since={busyAt} /> : null}
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
            />
          </>
        )}
      </Box>

      {/* footer: live status (model/AUTO/reasoning) + contextual hint, one line */}
      <Box paddingLeft={1} justifyContent="space-between">
        <Text color={theme.faint}>
          {pending ? '↑↓ + enter · or R/E/A/N · esc cancels' : busy ? 'esc to interrupt' : '/help · tab auto-approve · esc interrupt'}
        </Text>
        <Text>
          {autoApprove && <Text color={theme.warn} bold>AUTO {glyphs.bolt} </Text>}
          {reasoning && <Text color={theme.faint}>{glyphs.thought} think </Text>}
          <Text color={theme.brandDim}>{model}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// Wraps TextInput to add ↑/↓ history. Ink's useInput in parent doesn't see keys
// while TextInput is focused, so we intercept here via a controlled value.
function PromptInput({ value, onChange, onSubmit, disabled, history, histIdx, setInput }) {
  useInput((ch, key) => {
    if (disabled) return;
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
  }, { isActive: !disabled });

  if (disabled) return <Text color={theme.faint}>{value || '(decide above ↑)'}</Text>;
  return <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="talk to termita…" />;
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
      return (
        <Box flexDirection="column">
          <ToolCard name={item.name} args={item.args} danger={item.danger} status={item.status} awaiting={item.status === 'running'} />
          {(item.status === 'running' || item.status === 'done') && (
            <OutputStream text={item.output} done={item.status === 'done'} exitCode={item.exitCode} interrupted={item.interrupted} startedAt={item.startedAt} />
          )}
        </Box>
      );
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
