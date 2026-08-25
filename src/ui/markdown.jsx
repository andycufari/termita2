// Lightweight Markdown → Ink renderer. The model speaks Markdown; Ink's <Text>
// prints it raw, so tables/bold/headers look garbled. This parses the common
// subset the model actually emits and renders it themed to Termita's palette.
// No deps — a focused block/inline parser, not a full CommonMark engine.
//
// Handles: fenced code blocks (```), tables (| … |), headers (#..######),
// blockquotes (>), unordered (-,*,+) and ordered (1.) lists, horizontal rules,
// and inline **bold** / *italic* / `code` / ~~strike~~ / [links](url).
// Anything it doesn't recognize falls through as plain text, so it never eats
// content it can't format.
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

// --- Inline spans ----------------------------------------------------------
// Split a line into styled <Text> runs. Order matters: code first (its content
// is literal), then links, then emphasis. Returns an array of React nodes.
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/;

export function renderInline(text, keyPrefix = 'i') {
  if (!text) return [text];
  const out = [];
  let rest = String(text);
  let n = 0;
  while (rest.length) {
    const m = rest.match(INLINE_RE);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index)); // plain lead
    const tok = m[0];
    const k = `${keyPrefix}${n++}`;
    if (m[1]) {
      out.push(<Text key={k} color={theme.ok} backgroundColor={theme.borderDim}>{tok.slice(1, -1)}</Text>);
    } else if (m[2]) {
      out.push(<Text key={k} bold color={theme.text}>{tok.slice(2, -2)}</Text>);
    } else if (m[3]) {
      out.push(<Text key={k} italic>{tok.slice(1, -1)}</Text>);
    } else if (m[4]) {
      out.push(<Text key={k} strikethrough color={theme.dim}>{tok.slice(2, -2)}</Text>);
    } else if (m[5]) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      out.push(
        <Text key={k}>
          <Text color={theme.text}>{lm[1]}</Text>
          <Text color={theme.brandDim}> ({lm[2]})</Text>
        </Text>,
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

// visible length of a cell after stripping inline markers (for table widths)
function visLen(s) {
  return String(s)
    .replace(/\*\*|__|~~|[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1 ($2)')
    .length;
}

// --- Block parsing ---------------------------------------------------------
// Group raw lines into blocks. We only need enough structure to render; this
// isn't a spec-complete tokenizer.
function parseBlocks(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // consume closing fence
      blocks.push({ type: 'code', lang, lines: body });
      continue;
    }

    // table: a header row of pipes followed by a separator row of ---
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const rows = [line];
      i += 2; // skip header + separator
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(lines[i]); i++; }
      blocks.push({ type: 'table', header: splitRow(line), rows: rows.slice(1).map(splitRow) });
      continue;
    }

    // header
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); i++; continue; }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // blockquote (contiguous > lines)
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'quote', lines: body });
      continue;
    }

    // list (contiguous unordered/ordered items)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*([-*+]|(\d+)\.)\s+(.*)$/);
        items.push({ ordered: !!m[2], num: m[2], text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // blank line → paragraph break
    if (line.trim() === '') { blocks.push({ type: 'blank' }); i++; continue; }

    // paragraph: gather until a blank or a block-starting line
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== ''
      && !/^\s*(#{1,6}\s|```|>|([-*+]|\d+\.)\s)/.test(lines[i])
      && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

function splitRow(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// --- Block renderers -------------------------------------------------------
const HEADING_COLOR = [null, 'brand', 'accent', 'ok', 'warn', 'brandDim', 'dim'];

function Table({ header, rows, width }) {
  const cols = header.length;
  // Rows are normalised to the header's column count. A model that emits a
  // ragged row (an unescaped `|` inside a cell is the common cause) used to
  // render EXTRA columns on that row only, so the row ran past the pane border
  // while every other row stayed inside it.
  const norm = rows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ''));

  // natural width of each column = widest visible cell
  const widths = header.map((h, c) => {
    let w = visLen(h);
    for (const r of norm) w = Math.max(w, visLen(r[c] || ''));
    return w;
  });

  // Clamp to the pane. Every column costs its own width plus 3 columns of
  // chrome (" │ "), and the row opens with a 2-column "│ " — so the real cost
  // is cols*3 + 2, not cols*3 + 1. The old figure was one short, which is why
  // a table sized to "exactly the budget" still poked one column past the
  // border.
  const budget = Math.max(8, width || 80);
  const overhead = cols * 3 + 2;
  const MIN_COL = 3;
  let avail = budget - overhead;
  if (avail < cols * MIN_COL) avail = cols * MIN_COL; // degenerate: see clamp below
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > avail) {
    // Shrink proportionally, then repair: flooring each column and applying a
    // MIN_COL floor can push the sum back OVER the budget (worst with many
    // columns, where the floor dominates). So after scaling we walk the widest
    // columns down until the row genuinely fits — the previous code trusted the
    // scale factor and silently overflowed.
    const scale = avail / total;
    for (let c = 0; c < cols; c++) widths[c] = Math.max(MIN_COL, Math.floor(widths[c] * scale));
    let sum = widths.reduce((a, b) => a + b, 0);
    while (sum > avail) {
      let widest = 0;
      for (let c = 1; c < cols; c++) if (widths[c] > widths[widest]) widest = c;
      if (widths[widest] <= 1) break; // can't shrink further; nothing left to give
      widths[widest] -= 1;
      sum -= 1;
    }
  }

  const cell = (txt, c) => {
    const w = widths[c];
    const raw = String(txt ?? '');
    const clipped = visLen(raw) > w ? clipVisible(raw, w) : raw;
    const pad = Math.max(0, w - visLen(clipped));
    return { clipped, pad };
  };

  // wrap="truncate-end" is the backstop: even if a width calculation is wrong
  // for some input we haven't seen, the row gets cut at the pane edge instead
  // of wrapping and shoving the layout around.
  const Row = ({ cells, bold, keyp }) => (
    <Text wrap="truncate-end">
      <Text color={theme.faint}>│ </Text>
      {cells.map((txt, c) => {
        const { clipped, pad } = cell(txt, c);
        return (
          <Text key={`${keyp}-${c}`}>
            <Text bold={bold} color={bold ? theme.brand : theme.text}>{renderInline(clipped, `${keyp}-${c}-`)}</Text>
            <Text>{' '.repeat(pad)}</Text>
            <Text color={theme.faint}> │ </Text>
          </Text>
        );
      })}
    </Text>
  );

  const rule = (
    <Text color={theme.faint} wrap="truncate-end">
      {'├─' + widths.map((w) => '─'.repeat(w + 1)).join('┼─') + '┤'}
    </Text>
  );

  return (
    <Box flexDirection="column" width={budget}>
      <Row cells={header} bold keyp="h" />
      {rule}
      {norm.map((r, ri) => <Row key={ri} cells={r} keyp={`r${ri}`} />)}
    </Box>
  );
}

// clip a string to `w` VISIBLE chars (markers don't count), add … if clipped
function clipVisible(s, w) {
  if (visLen(s) <= w) return s;
  // simple: strip markers then hard-cut (good enough for cells)
  const plain = String(s).replace(/\*\*|__|~~|[`*_]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return plain.slice(0, Math.max(1, w - 1)) + '…';
}

function Block({ block, width }) {
  switch (block.type) {
    case 'heading': {
      const color = theme[HEADING_COLOR[block.level] || 'brand'] || theme.brand;
      return <Text bold color={color} wrap="wrap">{block.level <= 2 ? '' : '· '}{renderInline(block.text, 'h')}</Text>;
    }
    case 'code':
      // Bounded to the pane and truncated, not wrapped. Code is the block most
      // likely to hold lines longer than a half-width pane, and unbounded it ran
      // through the border into the pane beside it. Truncating keeps one source
      // line on one row — a wrapped code line reads as two statements.
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.borderDim} paddingX={1} width={width ? Math.max(12, width) : undefined}>
          {block.lang ? <Text color={theme.brandDim} wrap="truncate-end">{block.lang}</Text> : null}
          {(block.lines.length ? block.lines : ['']).map((l, i) => (
            <Text key={i} color={theme.ok} wrap="truncate-end">{l || ' '}</Text>
          ))}
        </Box>
      );
    case 'table':
      return <Table header={block.header} rows={block.rows} width={width} />;
    case 'quote':
      return (
        <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={theme.brandDim} borderTop={false} borderRight={false} borderBottom={false} width={width ? Math.max(12, width) : undefined}>
          {block.lines.map((l, i) => <Text key={i} color={theme.dim} italic wrap="wrap">{renderInline(l, `q${i}`)}</Text>)}
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((it, i) => (
            <Text key={i} color={theme.text} wrap="wrap">
              <Text color={theme.brand}>{it.ordered ? `${it.num}.` : '•'} </Text>
              {renderInline(it.text, `l${i}`)}
            </Text>
          ))}
        </Box>
      );
    case 'hr':
      return <Text color={theme.faint}>{'─'.repeat(Math.max(8, Math.min((width || 80) - 4, 60)))}</Text>;
    case 'blank':
      return <Text> </Text>;
    case 'para':
    default:
      return <Text color={theme.text} wrap="wrap">{renderInline(block.text, 'p')}</Text>;
  }
}

// Public: render a Markdown string as a column of Ink blocks. `width` sizes
// tables/rules to the terminal.
//
// Memoised hard: in alt-screen the WHOLE transcript re-renders on every keystroke
// (and on every spinner/elapsed tick). Re-parsing every past assistant message's
// Markdown each frame made typing scale O(transcript) — the "typing gets slow /
// something's looping" symptom. parseBlocks is pure over `text`, so we cache it
// per-text and wrap the component in React.memo so unchanged messages don't
// re-parse or re-render at all.
function MarkdownImpl({ text, width }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => <Block key={i} block={b} width={width} />)}
    </Box>
  );
}

export const Markdown = React.memo(MarkdownImpl);
