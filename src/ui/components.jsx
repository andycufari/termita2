// Reusable Ink components for the transcript: message bubbles, tool cards,
// streaming output, spinner, approval bar, banners.
import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme, box, glyphs } from './theme.js';
import { Markdown } from './markdown.jsx';

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
            they don't show as raw pipes/asterisks. */}
        {who === 'you'
          ? <Text color={color} wrap="wrap">{text}</Text>
          : <Markdown text={text} width={(width || 80) - 2} />}
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
  const borderColor = isDanger ? theme.danger : status === 'done' ? theme.borderDim : theme.border;
  const title = name;
  const cmd = name === 'shell' ? args.command
    : name === 'write' ? args.path
    : name === 'websearch' ? args.query
    : (args.path || args.pattern);
  const why = args.why;

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={awaiting ? 0 : 1}>
      <Box
        flexDirection="column"
        borderStyle={isDanger ? box.danger : box.tool}
        borderColor={borderColor}
        paddingX={1}
      >
        <Text color={isDanger ? theme.danger : theme.brandDim} bold>
          {isDanger ? `${glyphs.skull} ${title}  DANGER` : title}
        </Text>
        <Text color={isDanger ? theme.danger : theme.ok}>
          {TOOL_ICON[name] || '·'} <Text color={theme.text}>{cmd}</Text>
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

// --- Approval menu (vertical, arrow-navigated; R/E/A/N still work) ----------
export const APPROVAL_ACTIONS = [
  { kind: 'run', key: 'R', label: 'Run', hint: 'run it once' },
  { kind: 'edit', key: 'E', label: 'Edit', hint: 'tweak the command' },
  { kind: 'always', key: 'A', label: 'Always', hint: 'allowlist this kind' },
  { kind: 'no', key: 'N', label: 'No', hint: 'decline' },
];

export function ApprovalMenu({ selected, danger }) {
  const runColor = danger ? theme.danger : theme.ok;
  const colorFor = (kind) =>
    kind === 'run' ? runColor :
    kind === 'edit' ? theme.brand :
    kind === 'always' ? theme.accent :
    theme.dim;

  return (
    <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
      {APPROVAL_ACTIONS.map((a, i) => {
        const active = i === selected;
        return (
          <Text key={a.kind}>
            <Text color={active ? colorFor(a.kind) : theme.faint} bold={active}>
              {active ? glyphs.bullet : ' '} {a.label.padEnd(7)}
            </Text>
            <Text color={active ? theme.text : theme.faint}>{a.hint}</Text>
          </Text>
        );
      })}
      <Text color={theme.faint}>  {glyphs.dot} ↑↓ move · enter select · or R/E/A/N · esc cancel</Text>
    </Box>
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
            <Text key={m.name} color={active ? theme.accent : theme.dim} bold={active}>
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
