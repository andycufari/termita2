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
import { Box } from 'ink';

export function Pane({
  width,          // columns for THIS pane (undefined = fill available)
  focused = false,
  bordered = false,
  borderColor,
  focusColor,
  clipBottom = 0,
  header = null,  // rendered above the scrolling region (e.g. a banner)
  footer = null,  // rendered below it, inside the pane (e.g. a prompt)
  children,
}) {
  const border = bordered
    ? { borderStyle: 'round', borderColor: focused ? focusColor : borderColor }
    : {};
  return (
    <Box flexDirection="column" width={width} flexGrow={width ? 0 : 1} flexShrink={1} {...border}>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" overflowY="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0} marginBottom={-clipBottom}>
          {header}
          {children}
        </Box>
      </Box>
      {footer}
    </Box>
  );
}

export default Pane;
