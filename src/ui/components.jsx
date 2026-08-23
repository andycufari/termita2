// Reusable Ink components for the transcript: message bubbles, tool cards,
// streaming output, spinner, approval bar, banners.
import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme, box, glyphs } from './theme.js';
import { Markdown } from './markdown.jsx';
import { Modal, ModalItem } from './modal.jsx';

// --- Spinner ----------------------------------------------------------------
export function Spinner({ label, color = theme.brand }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % glyphs.spinnerFrames.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={color}>
      {glyphs.spinnerFrames[frame]} {label}
    </Text>
  );
}

// --- Role label + message ---------------------------------------------------
function RoleTag({ who }) {
  if (who === 'you') {
    return (
      <Text>
        <Text color={theme.you} bold>{glyphs.you} you</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={theme.term} bold>{glyphs.term} term</Text>
    </Text>
  );
}

export function Message({ who, text, reasoning, thoughtMs, width }) {
  const color = who === 'you' ? theme.user : theme.text;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <RoleTag who={who} />
      {reasoning && thoughtMs != null && (
        <Text color={theme.faint} italic>
          {'  '}{glyphs.thought} thought for {(thoughtMs / 1000).toFixed(1)}s
        </Text>
      )}
      <Box paddingLeft={2}>
        {/* The user types plain text; the model emits Markdown (tables, bold,
            code, lists) — render its replies through the Markdown component so
            they don't show as raw pipes/asterisks.
            Width is the pane's content width MINUS this paddingLeft(2); otherwise
            text wraps to the full width and spills 2 cols past the right border.
            Wrap the whole column too so `wrap` has a hard box to break against. */}
        <Box width={Math.max(10, (width || 80) - 2)}>
          {who === 'you'
            ? <Text color={color} wrap="wrap">{text}</Text>
            : <Markdown text={text} width={(width || 80) - 2} />}
        </Box>
      </Box>
    </Box>
  );
}

// Streaming assistant message (live tokens) ---------------------------------
export function StreamingMessage({ text, thinking, startedAt }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <RoleTag who="term" />
      {thinking && (
        <Box paddingLeft={2}>
          <Text color={theme.faint} italic>{glyphs.thought} thinking… </Text>
          {startedAt ? <Elapsed since={startedAt} /> : null}
          <Text color={theme.faint}>  · esc to interrupt</Text>
        </Box>
      )}
      {text ? (
        <Box paddingLeft={2}>
          <Text color={theme.text} wrap="wrap">
            {text}
            <Text color={theme.brand}>▌</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// --- Tool card --------------------------------------------------------------
const TOOL_ICON = { shell: '$', write: glyphs.bolt, read: '📖', grep: '🔍', websearch: '🌐' };

export function ToolCard({ name, args, danger, status, awaiting }) {
  const isDanger = !!danger;
  const cmd = name === 'shell' ? args.command
    : name === 'write' ? args.path
    : name === 'websearch' ? args.query
    : (args.path || args.pattern);
  const why = args.why;
  const icon = TOOL_ICON[name] || '·';

  // COMPACT by default: one line, no box. A transcript is mostly a list of
  // commands, and a 5-row bordered card each — plus a repeated "why" — buried the
  // actual content (a screenful held ~5 commands). The box is reserved for the
  // cases that genuinely need attention: a danger flag, or a pending approval.
  if (!isDanger && !awaiting) {
    const dim = status === 'done';
    return (
      <Box paddingLeft={2}>
        <Text color={dim ? theme.borderDim : theme.brandDim}>{name} </Text>
        <Text color={dim ? theme.okDim : theme.ok}>{icon} </Text>
        <Text color={dim ? theme.dim : theme.text}>{cmd}</Text>
        {name === 'read' && args.range ? <Text color={theme.dim}> ({args.range})</Text> : null}
      </Box>
    );
  }

  // Expanded: danger or awaiting a decision — worth the space and the border.
  const borderColor = isDanger ? theme.danger : theme.border;
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={awaiting ? 0 : 1}>
      <Box
        flexDirection="column"
        borderStyle={isDanger ? box.danger : box.tool}
        borderColor={borderColor}
        paddingX={1}
      >
        <Text color={isDanger ? theme.danger : theme.brandDim} bold>
          {isDanger ? `${glyphs.skull} ${name}  DANGER` : name}
        </Text>
        <Text color={isDanger ? theme.danger : theme.ok}>
          {icon} <Text color={theme.text}>{cmd}</Text>
        </Text>
        {name === 'read' && args.range && <Text color={theme.dim}>  range {args.range}</Text>}
        {why && <Text color={theme.dim} italic>{why}</Text>}
        {isDanger && (
          <Text color={theme.danger} bold>{glyphs.cross} {danger} — review carefully</Text>
        )}
      </Box>
    </Box>
  );
}

// --- Elapsed timer (ticks while a command runs) -----------------------------
function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, (now - since) / 1000);
  return <Text color={theme.brandDim}>{s.toFixed(1)}s</Text>;
}

// --- Live output stream -----------------------------------------------------
// Real terminal feel: stdout/stderr streams into this box line-by-line as the
// command runs. While running we show a rolling tail + a live elapsed timer so
// it's obviously ALIVE (not hung). When done, the full output is rendered so it
// lands in the terminal's scrollback and you can scroll up to read all of it.
const LIVE_TAIL = 18; // lines kept in the live region while still running

export function OutputStream({ text, done, exitCode, interrupted, startedAt }) {
  const raw = text || '';
  const lines = raw.split('\n');
  const hasOutput = raw.trim() !== '' && raw.trim() !== '(no output)';

  const shown = !done && lines.length > LIVE_TAIL ? lines.slice(-LIVE_TAIL) : lines;
  const rolledPast = !done ? lines.length - shown.length : 0;

  let statusColor = theme.dim;
  let statusText = null;
  if (done) {
    if (interrupted) { statusColor = theme.warn; statusText = '⊘ interrupted'; }
    else if (exitCode === 0 || exitCode == null) { statusColor = theme.okDim; statusText = `${glyphs.check} done`; }
    else { statusColor = theme.danger; statusText = `${glyphs.cross} exit ${exitCode}`; }
  }

  const borderColor = !done ? theme.brandDim : theme.faint;

  return (
    <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
      <Box flexDirection="column" borderStyle="single" borderColor={borderColor} borderLeft borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
        {/* live header while running: spinner + elapsed + stop hint */}
        {!done && (
          <Box>
            <Spinner label="running" color={theme.brand} />
            <Text color={theme.dim}> · </Text>
            {startedAt ? <Elapsed since={startedAt} /> : null}
            <Text color={theme.faint}>  · esc to stop</Text>
          </Box>
        )}
        {rolledPast > 0 && <Text color={theme.faint}>↑ {rolledPast} lines scrolled past (full output shown when it finishes)</Text>}
        {hasOutput
          ? shown.map((l, i) => <Text key={i} color={theme.dim} wrap="wrap">{l || ' '}</Text>)
          : (!done
              ? <Text color={theme.faint} italic>waiting for output…</Text>
              : <Text color={theme.faint} italic>(no output)</Text>)}
        {statusText && <Text color={statusColor} bold>{statusText}</Text>}
      </Box>
    </Box>
  );
}

// --- Approval modal (Norton-style centered dialog) --------------------------
// This used to be a flat block in the chat pane's footer. In dual mode a ~50-col
// pane gives the footer no guaranteed height, so Flexbox squeezed the four
// options away — you were asked to approve something with nothing to pick from.
// A decision this important gets a real dialog: it can't be clipped, it shows
// the FULL command, and each option spells out what it actually does.
export const APPROVAL_ACTIONS = [
  { kind: 'run', key: 'R', label: 'Run',    hint: 'execute it once, this time only' },
  { kind: 'edit', key: 'E', label: 'Edit',   hint: 'change the command before running' },
  { kind: 'always', key: 'A', label: 'Always', hint: 'run it and never ask for this kind again' },
  { kind: 'no', key: 'N', label: 'No',     hint: 'decline — nothing runs' },
];

// What the tool is about to do, in plain words. The tool NAME alone ("write",
// "shell") doesn't say whether something gets executed or a file gets replaced,
// which is exactly what you need to know before pressing a key.
const ACTION_VERB = {
  shell: 'run a shell command',
  write: 'write to a file',
  read: 'read a file',
  websearch: 'search the web',
  list: 'list a directory',
  grep: 'search file contents',
};

export function ApprovalModal({ pending, selected, width }) {
  const { name, args, danger } = pending;
  const subject = name === 'shell' ? args.command
    : name === 'write' ? args.path
    : name === 'websearch' ? args.query
    : (args.path || args.pattern || '');
  const why = args.why;
  const color = danger ? theme.danger : theme.brand;
  // Wrap rather than truncate: this is the thing being approved, so every
  // character of it has to be visible before you can fairly say yes.
  const bodyWidth = Math.max(24, (width || 60) - 6);

  return (
    <Modal
      width={width}
      color={color}
      title={danger ? `${glyphs.skull}  DANGER — approve?` : `${glyphs.bolt}  termita wants to ${ACTION_VERB[name] || `use ${name}`}`}
      hint={`${glyphs.dot} ↑↓ move · enter select · R/E/A/N · esc cancel`}
    >
      {/* The command itself, boxed and full-width so it can't be mistaken for
          chrome and can't be half-hidden. */}
      <Box flexDirection="column" borderStyle="round" borderColor={danger ? theme.danger : theme.border} paddingX={1} marginBottom={1}>
        <Text color={theme.faint}>{name}</Text>
        <Box width={bodyWidth}>
          <Text color={theme.text} bold>{subject}</Text>
        </Box>
        {name === 'read' && args.range ? <Text color={theme.dim}>range {args.range}</Text> : null}
      </Box>

      {/* The model's own reason. Shown BEFORE the options: "why am I being
          asked this" is part of the decision, not a footnote. */}
      {why && (
        <Box width={bodyWidth} marginBottom={1}>
          <Text color={theme.dim} italic>{glyphs.dot} {why}</Text>
        </Box>
      )}

      {danger && (
        <Box width={bodyWidth} marginBottom={1}>
          <Text color={theme.danger} bold>{glyphs.cross} {danger} — review carefully</Text>
        </Box>
      )}

      {APPROVAL_ACTIONS.map((a, i) => {
        const active = i === selected;
        // "Always" on a dangerous command is a trap: the gate re-prompts anyway,
        // so promising otherwise here would be a lie.
        const hint = danger && a.kind === 'always'
          ? 'allowlist it — dangerous commands still prompt'
          : a.hint;
        return (
          <ModalItem
            key={a.kind}
            selected={active}
            color={a.kind === 'run' ? (danger ? theme.danger : theme.ok) : a.kind === 'no' ? theme.warn : theme.brand}
          >
            <Text bold={active}>{a.key}</Text>
            <Text>  {a.label.padEnd(7)}</Text>
            <Text color={active ? theme.text : theme.faint}>{hint}</Text>
          </ModalItem>
        );
      })}
    </Modal>
  );
}

// --- Slash-command autocomplete dropdown ------------------------------------
// Shown above the input while the user is typing a `/command`. Arrow-navigable;
// Tab/Enter completes the highlighted one. `selected` is the highlighted index.
export function CommandMenu({ matches, selected, width }) {
  if (!matches.length) return null;
  // pad the usage column to align descriptions; clamp to terminal width
  const usageW = Math.min(22, Math.max(...matches.map((m) => m.usage.length)) + 2);
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        {matches.map((m, i) => {
          const active = i === selected;
          const line = `${m.usage.padEnd(usageW)}${m.desc}`;
          const clamped = width && line.length > width - 8 ? line.slice(0, width - 9) + '…' : line;
          return (
            <Text key={m.name} color={active ? theme.brand : theme.dim} bold={active}>
              {active ? glyphs.bullet : ' '} {clamped}
            </Text>
          );
        })}
        <Text color={theme.faint}>  {glyphs.dot} ↑↓ move · tab/enter complete · esc cancel</Text>
      </Box>
    </Box>
  );
}

// --- Termita mascot + version (bottom-left footer brand) ---------------------
// Tiny termite glyph; sits at the bottom-left corner with the current version.
export function MascotTag({ version }) {
  return (
    <Box>
      <Text color={theme.brand}>{glyphs.termite}</Text>
      <Text color={theme.brandDim} bold> termita</Text>
      <Text color={theme.faint}> v{version}</Text>
    </Box>
  );
}

// --- Inline notices / errors ------------------------------------------------
export function Notice({ text, level }) {
  const color =
    level === 'ok' ? theme.ok :
    level === 'warn' ? theme.warn :
    level === 'danger' ? theme.danger :
    theme.dim;
  const icon =
    level === 'ok' ? glyphs.check :
    level === 'warn' ? '!' :
    level === 'danger' ? glyphs.cross :
    glyphs.dot;
  return (
    <Box paddingLeft={2} marginBottom={1}>
      <Text color={color}>{icon} {text}</Text>
    </Box>
  );
}

export function ErrorBox({ message }) {
  return (
    <Box paddingLeft={2} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.danger} paddingX={1}>
        <Text color={theme.danger}>{glyphs.cross} {message}</Text>
      </Box>
    </Box>
  );
}
