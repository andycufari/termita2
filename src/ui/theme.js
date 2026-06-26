// Cyber-neon theme. Colors are hex (Ink → truecolor when the terminal supports it).
export const theme = {
  name: 'neon',
  // brand / accents
  brand: '#00e5ff', // cyan — termita
  brandDim: '#0891a3',
  accent: '#ff4dd8', // magenta — highlights, "you"
  accentDim: '#a8327f',
  ok: '#39ff14', // neon green — success
  okDim: '#1f8f0c',
  warn: '#ffd23f', // amber — warnings
  danger: '#ff3864', // hot red — danger
  // text
  text: '#d7e0e8',
  dim: '#5b6b7a',
  faint: '#3a4654',
  // surfaces
  border: '#1b9aaa',
  borderDim: '#234',
  // role labels
  you: '#ff4dd8',
  term: '#00e5ff',
  user: '#c7d2da',
};

// Box-drawing presets for Ink <Box borderStyle>. Ink ships "round","single",
// "double","bold","classic". We use round for soft neon panels.
export const box = {
  panel: 'round',
  tool: 'round',
  danger: 'round',
};

export const glyphs = {
  prompt: '›',
  you: '◆',
  term: '◇',
  bullet: '▸',
  run: '⏵',
  spinnerFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  dot: '•',
  arrow: '→',
  check: '✓',
  cross: '✗',
  bolt: '⚡',
  lock: '🔒',
  skull: '☠',
  thought: '✦',
  termite: 'ƛ', // little mascot glyph for the footer brand
};
