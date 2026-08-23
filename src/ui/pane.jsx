// A scrollable transcript pane.
//
// The structure here is load-bearing and subtle, so it lives in one place rather
// than being duplicated per pane:
//
//   overflowY:hidden + justifyContent:flex-end  → content pins to the BOTTOM and
//     is clipped at the top, which is what a transcript wants.
//   marginBottom={-clipBottom}                  → slides content down past the
//     fold so the partly-scrolled boundary item's trailing rows get cut. This is
//     what makes scrolling row-continuous instead of snapping item-to-item.
//
// Verified: two of these side by side in a flexDirection="row" container clip
// INDEPENDENTLY, so each pane scrolls without disturbing the other.
import React from 'react';
import { Box, Text } from 'ink';

export function Pane({
  width,          // columns for THIS pane (undefined = fill available)
  focused = false,
  bordered = false,
  borderColor,
  focusColor,
  clipBottom = 0,
  title = null,   // fixed one-line label pinned to the TOP of the pane
  header = null,  // rendered above the scrolling region, scrolls with it
  footer = null,  // rendered below it, inside the pane
  children,
}) {
  // The FOCUSED pane gets a heavier border as well as its own colour — on a dim
  // terminal (or for anyone who can't rely on hue) the active side should still
  // read as active from the line weight alone.
  const border = bordered
    ? {
        borderStyle: focused ? 'bold' : 'round',
        borderColor: focused ? focusColor : borderColor,
      }
    : {};
  return (
    <Box flexDirection="column" width={width} flexGrow={width ? 0 : 1} flexShrink={1} {...border}>
      {/* Title is OUTSIDE the scrolling region: it stays pinned while content
          scrolls under it (Norton's pane header). flexShrink={0} so a full pane
          can never squeeze it away. */}
      {title && <Box flexShrink={0}>{title}</Box>}
      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0} marginBottom={-clipBottom}>
          {header}
          {children}
        </Box>
      </Box>
      {/* flexShrink={0}: the footer carries live state (running command, spinner,
          queued messages). Without this the greedy scroll region above squeezes
          it to nothing exactly when a pane is full — which is when that state
          matters most. */}
      {footer && <Box flexShrink={0} flexDirection="column">{footer}</Box>}
    </Box>
  );
}

// A pane's header line: a label on the left, live context on the right, clipped
// to the pane width. Middle-truncates the context (a path's TAIL and a model
// name's HEAD are the informative ends) rather than letting it wrap and shove
// the layout around.
export function PaneTitle({ label, context, width, color, dimColor, badge, badgeColor }) {
  // The badge (e.g. auto-approve) is pinned to the RIGHT and reserved FIRST:
  // it's a mode you're currently in, so it must never be the thing that gets
  // truncated away when the context string is long.
  const badgeLen = badge ? badge.length + 2 : 0;
  const avail = Math.max(8, (width || 40) - label.length - 4 - badgeLen);
  let shown = context || '';
  if (shown.length > avail) shown = `…${shown.slice(-(avail - 1))}`;
  return (
    <Box paddingX={1}>
      <Text color={color} bold>{label}</Text>
      <Text color={dimColor}>{shown ? `  ${shown}` : ''}</Text>
      {badge && (
        <>
          <Box flexGrow={1} />
          <Text color={badgeColor} bold>{badge}</Text>
        </>
      )}
    </Box>
  );
}

export default Pane;
