// A centered dialog that REPLACES the pane region instead of stacking above the
// input.
//
// Why: these menus used to live in the bottom chrome, so opening one pushed the
// panes (and each other) up the screen — the layout jumped on every share prompt,
// model pick and rewind. In a Norton-style UI the panes are fixed furniture; a
// menu is a dialog over them, not another row in a stack.
//
// Ink has no absolute positioning, so "floating" is done by rendering this in
// place of the pane row and matching its height. The panes are unmounted while a
// modal is open — their state lives in React above, so they come back untouched.
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export function Modal({ title, hint, color = theme.brand, width, children }) {
  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={color}
        paddingX={2}
        paddingY={0}
        width={width}
      >
        {title && (
          <Box marginBottom={1}>
            <Text color={color} bold>{title}</Text>
          </Box>
        )}
        {children}
        {hint && (
          <Box marginTop={1}>
            <Text color={theme.faint}>{hint}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// One selectable row. Extracted so every modal's list looks identical — the old
// menus each hand-rolled their own bullet/colour logic and had drifted apart.
export function ModalItem({ selected, children, color = theme.ok, dim = theme.dim }) {
  return (
    <Text color={selected ? color : dim} bold={selected}>
      {selected ? '▸' : ' '} {children}
    </Text>
  );
}

export default Modal;
