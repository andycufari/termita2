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
import React from 'react';
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
  // natural width of each column = widest visible cell
  const widths = header.map((h, c) => {
    let w = visLen(h);
    for (const r of rows) w = Math.max(w, visLen(r[c] || ''));
    return w;
  });
  // clamp total to terminal width (2 padding + 1 separator per column)
  const budget = Math.max(20, (width || 80) - 4);
  const overhead = cols * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  if (total > budget) {
    // shrink proportionally, floor 4
    const scale = (budget - overhead) / (total - overhead);
    for (let c = 0; c < cols; c++) widths[c] = Math.max(4, Math.floor(widths[c] * scale));
  }

  const cell = (txt, c) => {
    const w = widths[c];
    const raw = String(txt ?? '');
    const clipped = visLen(raw) > w ? clipVisible(raw, w) : raw;
    const pad = Math.max(0, w - visLen(clipped));
    return { clipped, pad };
  };

  const Row = ({ cells, bold, keyp }) => (
    <Text>
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
    <Text color={theme.faint}>
      {'├─' + widths.map((w) => '─'.repeat(w + 1)).join('─┼─') + '─┤'}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Row cells={header} bold keyp="h" />
      {rule}
      {rows.map((r, ri) => <Row key={ri} cells={r} keyp={`r${ri}`} />)}
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
      return <Text bold color={color}>{block.level <= 2 ? '' : '· '}{renderInline(block.text, 'h')}</Text>;
    }
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.borderDim} paddingX={1}>
          {block.lang ? <Text color={theme.brandDim}>{block.lang}</Text> : null}
          {(block.lines.length ? block.lines : ['']).map((l, i) => (
            <Text key={i} color={theme.ok}>{l || ' '}</Text>
          ))}
        </Box>
      );
    case 'table':
      return <Table header={block.header} rows={block.rows} width={width} />;
    case 'quote':
      return (
        <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={theme.brandDim} borderTop={false} borderRight={false} borderBottom={false}>
          {block.lines.map((l, i) => <Text key={i} color={theme.dim} italic>{renderInline(l, `q${i}`)}</Text>)}
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((it, i) => (
            <Text key={i} color={theme.text}>
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
export function Markdown({ text, width }) {
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => <Block key={i} block={b} width={width} />)}
    </Box>
  );
}
