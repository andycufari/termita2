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

// Block-letter TERMITA wordmark (each line padded to equal width so the neon
// fill is a clean rectangle). Shown big on first run; compact otherwise.
const TERMITA_ART = [
  '████████ ███████ ██████  ███    ███ ██ ████████  █████  ',
  '   ██    ██      ██   ██ ████  ████ ██    ██    ██   ██  ',
  '   ██    █████   ██████  ██ ████ ██ ██    ██    ███████  ',
  '   ██    ██      ██   ██ ██  ██  ██ ██    ██    ██   ██  ',
  '   ██    ███████ ██   ██ ██      ██ ██    ██    ██   ██  ',
];

// Big ASCII-art splash — first run (or a wide enough terminal). Includes the
// version so it's obvious which build is running.
function BigBanner({ version }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      {TERMITA_ART.map((row, i) => (
        <Text key={i} color={theme.brand} bold>{row}</Text>
      ))}
      <Box marginTop={1}>
        <Text>
          <Text color={theme.accent} bold>{glyphs.termite} terminal copilot</Text>
          <Text color={theme.dim}>  ·  v{version}</Text>
          <Text color={theme.dim}>  ·  ride shotgun</Text>
        </Text>
      </Box>
      <Text color={theme.dim}>one command at a time. you drive, it rides.</Text>
      <Text color={theme.faint}>/help for commands · tab = auto-approve · esc = interrupt</Text>
    </Box>
  );
}

// Compact neon wordmark for subsequent renders / narrow terminals.
function CompactBanner({ version }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Text color={theme.brand} bold>{'  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄'}</Text>
      <Text>
        <Text color={theme.accent} bold>  ▌ </Text>
        <Text color={theme.brand} bold>termita</Text>
        {version ? <Text color={theme.faint}> v{version}</Text> : null}
        <Text color={theme.dim}> · ride shotgun</Text>
        <Text color={theme.accent} bold> ▐</Text>
      </Text>
      <Text color={theme.brand} bold>{'  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'}</Text>
      <Text color={theme.dim}>  one command at a time. you drive, it rides.</Text>
      <Text color={theme.faint}>  /help for commands · tab = auto-approve · esc = interrupt</Text>
    </Box>
  );
}

// `firstRun` (or a terminal wide enough for the art) → big splash with version.
// Otherwise the compact wordmark. `columns` avoids wrapping the art on small
// terminals, which would look broken.
export function Banner({ version, firstRun = false, columns = 80 }) {
  const wideEnough = columns >= 58; // art is ~56 cols; leave a little margin
  if (firstRun && wideEnough) return <BigBanner version={version} />;
  return <CompactBanner version={version} />;
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
