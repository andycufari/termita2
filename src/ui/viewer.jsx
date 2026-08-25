// A read-only file viewer for the right pane — the Norton Commander half of the
// split.
//
// Why a distinct pane MODE rather than just dumping `cat` into the shell pane:
// a file you're reading needs its own scroll position, its own title, and it
// must NOT be interleaved with command output (which keeps arriving and would
// scroll the file away under you). So the right pane renders EITHER the shell
// transcript or this, and the viewer owns its own offset.
//
// Line numbers are rendered in a fixed-width gutter so the text column starts at
// the same place on every line — the thing that makes a wall of Markdown
// readable rather than ragged.
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { Markdown } from './markdown.jsx';

// Content wider than the pane is CLIPPED, not wrapped, when showing raw lines:
// a wrapped source line silently breaks the line/row correspondence that line
// numbers promise. ←/→ pans instead. Prose (rendered Markdown) wraps normally,
// since there are no line numbers to keep honest.
export function Viewer({ file, width, height, focused }) {
  const { path: filePath, lines = [], error, rendered, offset = 0, hOffset = 0, missing } = file || {};

  if (error) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.danger} wrap="wrap">{error}</Text>
      </Box>
    );
  }
  if (missing) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.faint} italic wrap="wrap">no file open — /view &lt;path&gt; to open one</Text>
      </Box>
    );
  }

  // Rendered Markdown mode: hand the visible slice to the Markdown renderer.
  // We still window by SOURCE lines (cheap and predictable); the rendered height
  // can differ slightly from the raw height, which is why the pane clips.
  if (rendered) {
    const slice = lines.slice(offset, offset + Math.max(1, height)).join('\n');
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Markdown text={slice} width={Math.max(10, width - 2)} />
      </Box>
    );
  }

  const total = lines.length;
  const gutter = String(Math.max(1, total)).length;
  const textWidth = Math.max(8, width - gutter - 3);
  const visible = lines.slice(offset, offset + Math.max(1, height));

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((line, i) => {
        const n = offset + i + 1;
        // Pan horizontally rather than wrap: see the note above.
        const text = hOffset ? String(line).slice(hOffset) : String(line);
        return (
          <Text key={n} wrap="truncate-end">
            <Text color={theme.faint}>{String(n).padStart(gutter, ' ')} </Text>
            <Text color={theme.borderDim}>│</Text>
            <Text color={theme.text}>{' ' + (text.length > textWidth ? text.slice(0, textWidth) : text)}</Text>
          </Text>
        );
      })}
      {visible.length === 0 && <Text color={theme.faint} italic>  (empty file)</Text>}
    </Box>
  );
}

// The viewer's status line, shown in the pane footer: position, mode and the
// keys that work here. Bindings are listed because the viewer is modal — the
// arrows mean something different while it's focused, and an undiscoverable
// mode is a broken one.
export function ViewerStatus({ file, height, focused, width }) {
  if (!file || file.missing || file.error) return null;
  const total = file.lines?.length || 0;
  const shown = Math.min(total, file.offset + Math.max(1, height));
  const pct = total === 0 ? 100 : Math.round((shown / total) * 100);
  return (
    <Box paddingX={1} width={width}>
      <Text color={theme.faint} wrap="truncate-end">
        {`${file.offset + 1}-${shown}/${total} ${pct}%`}
        {file.rendered ? ' · md' : ' · raw'}
        {focused ? ' · ↑↓ pgup/pgdn · m raw/md · q close' : ' · tab to focus'}
      </Text>
    </Box>
  );
}

export default Viewer;
