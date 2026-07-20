// Mouse-wheel scroll for the in-app transcript. In alt-screen mode the terminal
// has NO native scrollback (see cli.js), so the wheel does nothing by default.
// We enable SGR mouse reporting and translate wheel-up/down into scroll steps.
//
// CRITICAL — where we intercept: Ink 7 does NOT use the stdin 'data' event. It
// attaches a 'readable' listener and pulls bytes with `stdin.read()`, then feeds
// each chunk to its key parser (see ink/build/components/App.js handleReadable).
// A mouse report like `\x1b[<64;8;23M` isn't a key it knows, so it gets TYPED
// into the focused TextInput as literal `[<64;8;23M` garbage — more on every
// tick/click. Wrapping 'data' does nothing (that path is unused). So we wrap
// `stdin.read` itself: strip mouse reports out of what read() returns, handle
// the wheel/esc here, and hand Ink only the cleaned bytes. Nothing leaks.
//
// SGR (1006) + normal tracking (1000): SGR encodes coords as decimal in a
// `\x1b[<b;x;yM|m` sequence; 1000 reports button events — wheel ticks are 64 (up)
// / 65 (down); plain clicks (0) we drop. Works in iTerm2, Terminal.app (with
// Mouse Reporting on), kitty, Konsole, gnome-terminal, Windows Terminal, xterm.
import { useEffect } from 'react';
import { useStdin, useStdout } from 'ink';

// 1000 (normal tracking), NOT 1002 (button-event tracking). Both deliver wheel
// ticks, but 1002 also reports motion-while-pressed — i.e. it eats DRAG, which is
// exactly what the terminal needs for native text selection. With 1000 the wheel
// still scrolls the transcript while drag-to-select/copy keeps working, so this
// is no longer an either/or. (Alt-screen has no native scrollback, so turning
// capture off entirely leaves no way to scroll at all — see cli.js.)
const ENABLE = '\x1b[?1000h\x1b[?1006h'; // normal tracking + SGR extended coords
const DISABLE = '\x1b[?1006l\x1b[?1000l';

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

const MOUSE_RE_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g; // one full SGR mouse report
const MOUSE_TAIL_RE = /\x1b\[<[\d;]*$/; // an INCOMPLETE report at end of a chunk

// Pull wheel ticks + strip every mouse report out of `str`. Returns the net
// wheel delta (+up/-down) and the string with all reports removed.
function scrub(str) {
  let wheel = 0;
  let m;
  MOUSE_RE_G.lastIndex = 0;
  while ((m = MOUSE_RE_G.exec(str)) !== null) {
    const btn = Number(m[1]);
    if (btn === WHEEL_UP) wheel += 1;
    else if (btn === WHEEL_DOWN) wheel -= 1;
  }
  return { wheel, rest: str.replace(MOUSE_RE_G, '') };
}

// onWheel(delta) — net wheel ticks: + = scroll UP (older), - = DOWN (latest).
// onEscape() — fired on a lone Esc byte (interrupt a running command).
// enabled — when false we don't capture the mouse at all. Note alt-screen has NO
//   native scrollback, so that means no wheel scrolling whatsoever (PgUp/PgDn/
//   Home/End still work) — it's an escape hatch for terminals that mishandle
//   mode 1000, not the way to get text selection: mode 1000 already leaves drag
//   to the terminal. We still wrap read() to catch Esc. Toggle with /mouse.
export function useMouseWheel(onWheel, onEscape, enabled = true) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdin || !stdout || !isRawModeSupported) return undefined;
    if (typeof stdin.read !== 'function') return undefined;
    setRawMode(true);
    if (enabled) stdout.write(ENABLE);

    // A report can split across two reads (`\x1b[<64;8` then `;23M`); hold the
    // incomplete tail and prepend it to the next chunk so it never leaks.
    let carry = '';
    const origRead = stdin.read.bind(stdin);

    // Wrap read(): Ink calls this in a `while ((c = read()) !== null)` loop. We
    // filter each chunk before returning it. Ink accepts string or Buffer (it
    // re-encodes), so a scrubbed string is fine. If a chunk scrubs to empty
    // (all mouse), we DON'T return null early — that would end Ink's loop and
    // strand later bytes — instead we pull the next chunk until we have real
    // bytes to hand back or the stream is genuinely drained.
    stdin.read = (...readArgs) => {
      for (;;) {
        const raw = origRead(...readArgs);
        if (raw === null) return null; // stream drained for this tick

        let str = carry + (typeof raw === 'string' ? raw : raw.toString('utf8'));
        carry = '';

        // stash an incomplete trailing report for next time
        const tail = str.match(MOUSE_TAIL_RE);
        if (tail) { carry = tail[0]; str = str.slice(0, -tail[0].length); }
        // Safety valve: a well-formed SGR report is short (~a dozen bytes). If the
        // "incomplete" carry ever grows past this, it's not a real split report
        // (garbage/binary paste, a terminal that never terminates the sequence) —
        // drop it so it can't accumulate and get re-scanned on every read.
        if (carry.length > 64) carry = '';
        if (!str) continue;

        // lone Esc → interrupt (and still hand it to Ink so focus/esc works)
        if (str.length === 1 && str.charCodeAt(0) === 0x1b) { onEscape?.(); return str; }

        // no mouse bytes → pass through untouched
        if (str.indexOf('\x1b[<') === -1) return str;

        const { wheel, rest } = scrub(str);
        if (wheel !== 0) onWheel(wheel);
        if (rest.length) return rest;
        // else: whole chunk was mouse → loop and read the next one
      }
    };

    return () => {
      stdin.read = origRead; // restore
      if (enabled) stdout.write(DISABLE);
    };
  }, [stdin, stdout, isRawModeSupported, setRawMode, onWheel, onEscape, enabled]);
}
