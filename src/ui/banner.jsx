// Header frame + help panel.
import React from 'react';
import { Box, Text } from 'ink';
import { theme, glyphs } from './theme.js';
import { COMMANDS } from './commands.js';

export function Header({ model, endpoint, autoApprove, reasoning }) {
  const host = endpoint.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '');
  return (
    <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
      <Text>
        <Text color={theme.accent} bold>termita</Text>
        <Text color={theme.faint}> 2.0</Text>
        <Text color={theme.dim}>  {glyphs.bullet} terminal copilot</Text>
      </Text>
      <Text>
        {autoApprove && <Text color={theme.warn} bold>AUTO {glyphs.bolt}  </Text>}
        {reasoning && <Text color={theme.faint}>{glyphs.thought} think  </Text>}
        <Text color={theme.brand}>{model}</Text>
        <Text color={theme.dim}> @ {host}</Text>
      </Text>
    </Box>
  );
}

export function Banner() {
  // small neon wordmark shown once at startup
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Text color={theme.brand} bold>{'  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄'}</Text>
      <Text>
        <Text color={theme.accent} bold>  ▌ </Text>
        <Text color={theme.brand} bold>termita</Text>
        <Text color={theme.dim}> · ride shotgun</Text>
        <Text color={theme.accent} bold> ▐</Text>
      </Text>
      <Text color={theme.brand} bold>{'  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'}</Text>
      <Text color={theme.dim}>  one command at a time. you drive, it rides.</Text>
      <Text color={theme.faint}>  /help for commands · tab = auto-approve · esc = interrupt</Text>
    </Box>
  );
}

export function HelpPanel() {
  // Derived from the shared command registry so help never drifts from reality.
  const rows = COMMANDS.map((c) => [c.usage, c.desc]);
  const keys = [
    ['TAB', 'toggle auto-approve'],
    ['R / E / A / N', 'run / edit / always / no'],
    ['Esc', 'interrupt streaming or a prompt'],
    ['↑ / ↓', 'history (in input)'],
  ];
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
        <Text color={theme.brand} bold>slash commands</Text>
        {rows.map(([c, d]) => (
          <Text key={c}>
            <Text color={theme.accent}>{c.padEnd(20)}</Text>
            <Text color={theme.dim}>{d}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text color={theme.brand} bold>keys</Text>
        {keys.map(([c, d]) => (
          <Text key={c}>
            <Text color={theme.ok}>{c.padEnd(20)}</Text>
            <Text color={theme.dim}>{d}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
