// Make arbitrary command output SAFE to hand to Ink.
//
// Why this exists: we run commands with a real TERM, so tools believe they're
// talking to a terminal and emit control sequences — colour, cursor moves,
// erase-display, carriage-return progress bars. That output used to go straight
// into a <Text>, which writes those bytes to the REAL terminal. The result was
// exactly what you'd expect once something chatty ran (apt, a build, docker):
// the sequences repositioned the cursor and cleared regions BEHIND Ink's back,
// so Ink's idea of the screen and the actual screen diverged — the banner
// reappeared mid-session, panes leaked the desktop behind them, and the prompt
// showed fragments of half-eaten escapes.
//
// Ink can only own the screen if nothing else writes to it. So: strip every
// control sequence, and resolve the ones that carry MEANING (\r overwrite,
// backspace, tabs) into the plain text they were trying to produce.

// CSI: ESC [ params intermediates final    → colour, cursor moves, erase
// OSC: ESC ] ... BEL|ST                    → window title, hyperlinks
// Charset/simple: ESC ( B, ESC =, ESC 7 …  → single-char escapes
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g;
const SIMPLE_ESC = /\x1b[@-Z\\-_]|\x1b[ -/]*[0-~]/g;
// C0 controls except \t and \n (which we handle deliberately below). \r is
// handled BEFORE this, since it carries layout meaning.
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// A progress bar redraws one line with \r: "10%\r50%\r100%". Rendered literally
// that's one long smear. Real terminals show only what survives — the last
// write wins per column — and the cheap, correct-in-practice reading of that is
// "keep the text after the final \r on the line".
function resolveCarriageReturns(line) {
  if (line.indexOf('\r') === -1) return line;
  const segments = line.split('\r');
  // Later segments overwrite earlier ones from column 0. A shorter segment
  // leaves the tail of the longer one visible underneath, so overlay rather
  // than simply taking the last piece.
  let out = '';
  for (const seg of segments) {
    out = seg.length >= out.length ? seg : seg + out.slice(seg.length);
  }
  return out;
}

// Backspace erases the previous character — used by some tools for spinners
// and by `apt` for its progress redraw.
function resolveBackspaces(s) {
  if (s.indexOf('\b') === -1) return s;
  const out = [];
  for (const ch of s) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

export function sanitizeOutput(text) {
  if (!text) return '';
  let s = String(text);
  // Order matters: kill OSC first (it can CONTAIN bracket chars that would
  // otherwise confuse the CSI pass), then CSI, then whatever escapes remain.
  s = s.replace(OSC, '');
  s = s.replace(CSI, '');
  s = s.replace(SIMPLE_ESC, '');
  s = resolveBackspaces(s);
  s = s.split('\n').map(resolveCarriageReturns).join('\n');
  // Tabs survive as spaces: Ink measures width in characters, so a literal tab
  // renders as a 1-wide glyph and columns drift out of alignment.
  s = s.replace(/\t/g, '    ');
  s = s.replace(C0, '');
  return s;
}

export default sanitizeOutput;
