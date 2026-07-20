// Row-budget scrolling for a transcript pane.
//
// Alt-screen has no native scrollback, so a pane's content is one in-app-scrolled
// region measured in ROWS (not items — items range from 1 row to a dozen, and
// stepping by item count lurched unevenly and let Home slice the list empty).
//
// Extracted from app.jsx so goncho can run TWO independent panes: each needs its
// own scroll offset, its own row accounting, and — critically — its own growth
// anchor, or live output in one pane yanks the other pane's scroll position.
//
// The item-height estimator is INJECTED (`measure`) rather than imported: the chat
// pane measures rendered TranscriptItems, while a shell pane measures raw output
// lines. Same windowing math, different content.
import { useState, useRef, useCallback, useEffect } from 'react';

// Window a pane's items to the rows visible at a given scroll offset.
//
//   items      — the pane's item array (oldest first)
//   columns    — width available to THIS pane (drives text wrapping in `measure`)
//   rows       — total terminal rows
//   scrollUp   — rows scrolled up from the bottom; 0 = pinned to latest
//   measure    — (item, columns) => estimated rendered rows
//   extraRows  — fixed rows of content above the items (e.g. the banner)
//   chromeRows — fixed rows below the pane (input + footer); per-pane, since the
//                chat pane carries full chrome and a shell pane needs ~a prompt
//
// Returns everything the renderer needs, including `clipBottom`: the rows to hide
// off the LAST shown item. That's what makes scrolling row-continuous — the
// boundary item is usually only PARTLY scrolled off, and dropping it whole
// quantized scrolling to item boundaries (jumps of 10-17 rows, "page to page").
// The renderer applies it as marginBottom={-clipBottom} against an
// overflow:hidden + justifyContent:flex-end box.
export function computeWindow({ items, columns, rows, scrollUp, measure, extraRows = 0, chromeRows = 6 }) {
  const rowsPerItem = items.map((it) => measure(it, columns));
  const totalRows = rowsPerItem.reduce((a, b) => a + b, 0) + extraRows;
  const viewport = Math.max(3, rows - chromeRows);
  const maxScroll = Math.max(0, totalRows - viewport);
  const clampedScroll = Math.min(scrollUp, maxScroll);

  // Walk up from the bottom accumulating rows until we've covered the rows we're
  // scrolled past. Keep the straddling item and record how many of its trailing
  // rows to clip, instead of dropping it whole.
  const bottomDrop = clampedScroll;
  let acc = 0;
  let endIdx = items.length;   // exclusive; last item to show + 1
  let clipBottom = 0;          // rows to hide off the last shown item
  for (let i = items.length - 1; i >= 0; i--) {
    const next = acc + rowsPerItem[i];
    if (next >= bottomDrop) {
      endIdx = i + 1;
      clipBottom = bottomDrop - acc;
      break;
    }
    acc = next;
    if (i === 0) { endIdx = 0; clipBottom = 0; }
  }

  // Fill a viewport's worth of rows above endIdx, accounting for the clipped rows
  // so the visible row count stays constant as you scroll.
  let need = viewport + clipBottom + 2;
  let startIdx = endIdx;
  for (let i = endIdx - 1; i >= 0 && need > 0; i--) { need -= rowsPerItem[i]; startIdx = i; }

  return {
    shownItems: items.slice(startIdx, endIdx),
    startIdx,
    endIdx,
    clipBottom,
    clampedScroll, // scrollUp after clamping — what the UI should report

    totalRows,
    viewport,
    maxScroll,
    atBottom: clampedScroll === 0,
  };
}

// Per-pane scroll state + the derived window. Owns the scroll offset, the refs the
// key handlers read, and the growth anchor.
export function usePaneScroll({ items, columns, rows, measure, extraRows = 0, chromeRows = 6 }) {
  const [scrollUp, setScrollUp] = useState(0);
  const maxScrollRef = useRef(0);
  const totalRowsRef = useRef(0);
  const viewportRef = useRef(10);

  // Step by N ROWS, clamped to [0, maxScroll]: +up = older, -down = latest.
  // Shared by the wheel, PgUp/PgDn and Ctrl+↑/↓ so all stay consistent.
  const scrollBy = useCallback((step) => {
    setScrollUp((s) => Math.max(0, Math.min(maxScrollRef.current, s + step)));
  }, []);

  const win = computeWindow({ items, columns, rows, scrollUp, measure, extraRows, chromeRows });

  // Published during render for the key handlers (Home jumps to maxScroll, PgUp
  // steps by a viewport).
  totalRowsRef.current = win.totalRows;
  viewportRef.current = win.viewport;
  maxScrollRef.current = win.maxScroll;

  // Keep the view anchored when THIS pane grows. If we're scrolled up and new
  // content arrives, bump scrollUp by the rows added so the view stays on the same
  // content instead of drifting toward the bottom. (Pinned to bottom → stays 0 and
  // auto-follows.) Shrinks (/clear, rewind) are handled by the render-time clamp.
  const prevTotalRows = useRef(0);
  useEffect(() => {
    const total = totalRowsRef.current;
    const delta = total - prevTotalRows.current;
    prevTotalRows.current = total;
    if (delta > 0) setScrollUp((s) => (s > 0 ? s + delta : 0));
  }, [items]);

  return {
    ...win,
    scrollUp,
    setScrollUp,
    scrollBy,
    maxScrollRef,
    totalRowsRef,
    viewportRef,
  };
}
