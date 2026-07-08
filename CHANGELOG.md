# Changelog

All notable changes to **termita** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.9.0] — 2026-07-06

### Added
- **`!command` — run it yourself in the terminal.** Type a line starting with `!`
  (e.g. `!ls -la`, `!vim notes.txt`, `!git commit`, `!tail -f log`, `!python`) to
  run it **yourself** — no model round-trip, no approval gate. termita **suspends**
  (leaves the alt-screen, drops mouse capture, restores cooked input), runs it on
  the real terminal, and returns when it's done. Because it's the real terminal,
  *anything* works and is fully interactive — editors, REPLs, `$EDITOR`/password
  prompts, live TUIs, `tail -f` — exactly as in your shell. A `!cd` sticks (cwd
  recovered out-of-band via fd 3, so termita and the model follow you). Recalled
  verbatim with ↑ like any input.
- **Pause-on-exit + you choose what the model hears.** When a `!` command finishes
  (you `:wq`, it exits, or you Ctrl-C it), termita pauses on the result so you can
  read it, then offers: **enter** (tell the model you ran it — command only),
  **f** (share command + output), **e** (silent, model told nothing). Then you're
  back at the input with that choice *staged* — add a note or press enter to send
  as-is. A throwaway lookup stays private; a result worth acting on gets shared,
  optionally with your own take. This fixed the first cut, where re-entering the
  alt-screen instantly wiped a plain command's output before you could read it.
- **Auto capture-vs-handoff, with `!!` override.** A plain command (`ls`, `git`,
  `grep`, a build) runs piped — output tee'd to your screen live *and* captured, so
  **f** can share the real (trimmed; full on disk) output. A full-screen program
  (vim, htop, a REPL, `tail -f`) gets the real TTY, fully interactive, uncaptured
  (**f** isn't offered — there's nothing meaningful to capture). termita picks by a
  light heuristic on the command; **`!!command`** forces full-terminal mode for an
  interactive program it didn't recognize. No native PTY dependency — stays pure Node.

### Fixed
- **Transcript scroll "went to the top and bypassed history."** Scrolling was
  measured in *items*, but items have wildly different heights (a wrapped message
  vs a one-line output) while the viewport clips by *rows* — so the wheel lurched
  unevenly and `Home` sliced the list empty, showing just the banner. Scroll is
  now a **row budget**: each item's height is estimated, the offset is clamped to
  `total rows − viewport`, and the visible window is walked from the bottom in
  rows. The wheel now moves evenly, `PgUp`/`PgDn` step a real page, and `Home`
  lands on the oldest content with the viewport still full.

## [2.8.0] — 2026-07-05

### Added
- **User memory.** termita can now remember durable facts you tell it that it
  can't discover by running a command — preferences, project details, constraints.
  Say "remember I use pnpm here" and the model distills it to one line and saves
  it via a new `memory` tool (auto-runs, no approval). Notes are **project-scoped**
  (tied to the cwd) or **global** (machine-wide), the model's choice, and are
  injected into the system prompt every turn so it stops re-asking. Stored at
  `~/.config/termita/memory.json`. It deliberately does NOT save things it can
  probe (a tool being installed, a service running) — it runs a command for those.
- **`/memory`** — list / `add [-g] <note>` / `forget <n>` / `clear` by hand.
- **`/cognito [on|off]`** (alias `/incognito`) — a session privacy blackout:
  nothing is saved *and* nothing is recalled, so the model runs as if memory were
  empty. Resets off each launch; the footer shows 🕶️ while it's on.

## [2.7.7] — 2026-07-05

### Fixed
- **Double-Esc jump-back picker blinked open then shut.** A straggler Esc byte
  from the same press hit the picker's own Esc-close path (which had no burst
  guard) and closed what the press had just opened. Esc inside the picker now
  routes through the coalescing handler (window widened 40ms→60ms), so a real
  double-tap opens the picker and it stays. (#esc)

### Changed
- **Jump-back picker is cyan** (was pink/magenta) — border + title.

### Added
- **`/mouse [on|off]`** — toggle mouse capture. ON (default) = wheel scrolls the
  transcript (hold Option/Shift to select text). OFF = native drag-to-select and
  copy-paste work everywhere; the wheel falls back to the terminal's own
  scrollback. Persists to config.

## [2.7.6] — 2026-07-05

### Changed
- **Banner cleanup** — removed the duplicate text "TERMITA" that sat above the
  ASCII art; the version now trails the art, and the pirate 🏴‍☠️ / Argentina 🇦🇷
  flags flank the "Local AI first copilot for your console" line.
- **Input text is whitish** — the typed input is now wrapped in an explicit color
  so it no longer inherits the terminal's default foreground (green in some
  terminal themes).
- **`/` command menu highlight is cyan** (was pink/magenta).

## [2.7.5] — 2026-07-05

### Changed
- **ASCII splash shows on every launch**, not just first run — the banner was
  gated on `firstRun`, so after setup you only saw the one-line wordmark. Now the
  full box-drawing TERMITA art renders whenever the terminal is wide enough.
- **Input line is now bright cyan** (was pink/magenta) — the input box border and
  the `›` prompt marker.
- **`AUTO ⚡ (tab off)` → `AUTO-ACCEPT ⚡`** in the footer.

### Removed
- **Input placeholder** — the input is now a bare cursor (no "talk to termita…").
- **Idle hint line** under the input (`/help · /setup · tab auto-approve · …`).
  Contextual cues during approval/running/streaming are kept.

### Added
- **`/credits`** (alias `/about`) — 🏴‍☠️ termita 🇦🇷 · @andycufari · Enjoy the ride.

## [2.7.0] — 2026-07-05

### Fixed
- **Single Esc no longer opens the jump-back picker.** One physical Esc reaches
  the handler up to three times in the same tick (the mouse-wheel hook plus two
  mounted `useInput` handlers), and the double-Esc detector — keyed on
  `Date.now()` — treated the same-tick repeat as a second press, so a *single*
  Esc opened "jump back to…" and stranded you there. Esc events are now coalesced
  within a ~40 ms window: one Esc while busy interrupts and returns you to the
  input box; one Esc while idle only shows the "esc again to jump back" hint; two
  Esc opens the picker. (#esc)

### Added
- **Auto-detected context-window size.** The footer token gauge was hard-coded to
  8 192 regardless of what the model actually had loaded. On startup termita now
  asks the server (LM Studio's `/api/v0/models`, falling back to `/v1/models`) for
  the loaded model's context length and adopts it — so a model loaded at, say,
  120 k shows the real window. Best-effort and silent; never blocks or errors out.
- **`/context [n]` command** (alias `/ctx`) to show or override the context-window
  size the gauge uses. Accepts `32768`, `32k`, `128K`. Persisted to config.
- **Cancel row in the jump-back picker.** The "↩ jump back to…" list now ends with
  an explicit **cancel — keep going where I am** entry (arrow to it + Enter, or
  just press Esc) so it's obvious you can bail without rewinding.

### Changed
- **New splash + identity.** The startup banner is now `🏴‍☠️ TERMITA 🇦🇷` over a
  crisp box-drawing wordmark, with a single statement line — *Local AI first
  copilot for your console*. Dropped the old "ride shotgun / you drive, it rides"
  framing from the banner, the README, the system persona, and the package
  description. No buzzwords.

## [2.6.1] — 2026-07-05

### Fixed
- **Memory leak / OOM in long sessions** — after ~an hour of use the process
  could climb to ~4 GB and die with a V8 "heap out of memory" crash, with typing
  growing slower and slower ("like something is looping"). Two causes: shell
  commands held their **entire** output in memory, and the on-screen transcript
  array grew **without bound** (the alternate screen has no native scrollback, so
  every output line is a retained item). Both are now bounded.
- **Typing slowdown on large transcripts** — in the alternate screen the whole
  transcript re-renders on every keystroke, and each past reply's Markdown was
  **re-parsed every frame**. Markdown parsing is now memoized per message and
  transcript items are wrapped in `React.memo`, so a keystroke no longer
  re-parses or re-renders the entire history (was ~O(transcript) per key).

### Added
- **Full command output saved to disk + searchable by the model** — a command's
  complete output now streams to a per-command file under
  `~/.config/termita/sessions/<date>/cmd-<id>.out`, while only a bounded head+tail
  (first ~200 / last ~400 lines) is kept in memory. When output is trimmed, the
  result the model sees cites the file path, so it can `grep`/`read` the omitted
  middle on demand (no new tools — reuses the existing read-only ones). Nothing
  is lost; memory stays bounded. Files are removed on exit, and session folders
  older than 7 days are pruned on startup.
- **ASCII-art wordmark on first run** — the setup/first-run screen now shows a
  big block-letter **TERMITA** banner with the version; subsequent runs keep the
  compact wordmark (now also showing the version).

### Changed
- On-screen transcript is capped at 600 items; older lines are dropped with an
  "↑ N earlier lines trimmed" marker (the full output remains on disk).

## [2.6.0] — 2026-07-02

### Added
- **Web search (Brave)** — a `websearch` tool the model calls on its own when an
  answer depends on current or external info (latest versions, release dates,
  recent events, unfamiliar errors, changing docs). Read-only, so it auto-runs
  without approval like `read`/`grep`; results come back as titles · URLs ·
  snippets plus Brave's instant answer, and the model is prompted to cite the
  URLs it used. The tool is **hidden from the model until a key is set**, so it
  can never fail a search for a missing key.
- **`/websearch` command** — set/show/clear the Brave API key
  (`/websearch <key>`, `/websearch` for status, `/websearch off` to clear). Key
  is stored in `config.json` under `search.braveApiKey`, with a `BRAVE_API_KEY`
  environment-variable fallback. Aliases: `/brave`, `/search`.
- **Mouse-wheel scrolling** — the wheel now scrolls the in-app transcript. Since
  the alternate screen has no native scrollback, mouse reporting is enabled and
  wheel events are intercepted at Ink's `stdin.read()` (the path Ink 7 actually
  uses) and stripped before they reach the input — so wheel/click codes never
  leak into the prompt box.
- **`Ctrl+↑` / `Ctrl+↓` scrolling** — a keyboard fallback for scrolling the
  transcript, alongside the existing `PageUp`/`PageDown`/`Home`/`End`.
- **Markdown rendering** — the model's replies are now rendered from Markdown
  instead of shown raw: bordered/aligned **tables**, **bold**/*italic*/`code`/
  ~~strike~~/links, headings, bullet & numbered lists, blockquotes, fenced code
  blocks, and horizontal rules — themed to the neon palette. Streaming stays
  plain text until a reply completes, so you never see a half-drawn table.

### Fixed
- **Esc now reliably interrupts a running command / stream.** A stale-closure
  bug meant the Esc handler often read `busy` as `false` and fell through to the
  double-Esc *rewind* path instead of aborting. Esc state is now read through
  live refs, and a lone-Esc byte is also caught directly off stdin as a safety
  net for when Ink defers Esc to disambiguate escape sequences.

### Notes
- **Copying text:** in the alternate screen with mouse reporting on, use a
  modifier while dragging to select natively — **Option+drag** on macOS
  (iTerm2/Terminal.app), **Shift+drag** on most Linux terminals.

## [2.5.0] — 2026-06-26

### Fixed
- **Terminal resize artifacts** — resizing the window no longer leaves
  ghost/duplicate copies of the input box, stacked `term` headers, or a
  disappearing input/context footer. Root cause was a known Ink limitation
  ([ink#907](https://github.com/vadimdemedes/ink/issues/907)): the inline
  renderer erases the previous frame by logical line count and mis-handles line
  reflow on resize (only partially addressed even in Ink 7). Fixed by rendering
  into the **alternate screen buffer**, which repaints the whole UI each frame
  so reflow can't strand stale rows.

### Added
- **In-app transcript scrolling** — since the alternate screen has no native
  scrollback, the transcript is now a height-bounded, scrollable viewport.
  `PageUp`/`PageDown` scroll, `Home` jumps to the top, `End` returns to the
  latest. New output auto-follows the bottom unless you've scrolled up, and a
  `↑ scrolled up N` indicator shows when you're not pinned to the latest.

### Changed
- **Upgraded to Ink 7** (`ink` 5 → 7), **React 19.2**, and the build/runtime
  target to **Node 22** (`engines.node` is now `>=22`). Key handling was audited
  against Ink 7's breaking changes (`key.backspace` vs `key.delete`, `key.meta`
  no longer set on Escape) — no behavioral changes were needed.
- The transcript no longer settles into the terminal's native scrollback; on
  exit, the alternate screen is torn down and your shell is restored as it was.

## [2.3.0] — 2026-06-26

### Added
- **`/` command autocomplete** — typing a slash opens a dropdown of available
  commands in the input bar. `↑`/`↓` to navigate, `Tab` to complete (so you can
  add arguments like `/maxtokens 8192`), `Enter` to run the highlighted command,
  `Esc` to close. Backed by a shared command registry that also drives `/help`.
- **Interactive `/model` picker** — `/model` with no argument opens an arrow-key
  selectable list of models (windowed for long lists). `/model <id>` still works
  directly.
- **Responsive layout** — the TUI now reacts to the terminal size: the footer and
  hints compact on narrow windows, and long model ids / commands clamp with an
  ellipsis instead of overflowing.
- **Mascot + version** — `ƛ termita vX.Y.Z` is pinned to the bottom-left, with the
  version read from `package.json`.
- **Live running command** — the running indicator now shows the actual command
  being executed plus a "…no output for Ns — still working" nudge, so a long or
  quiet command no longer looks frozen.
- **`/maxtokens [n]`** — show or set the reply token budget (persisted to config).
- **Context gauge** — a footer gauge estimating session token usage against the
  configured context size, colored by how full the window is.

### Changed
- The input bar is now bordered, with `Ctrl+J` (and `Shift+Enter` / trailing `\`)
  for newlines.
- The multi-line input box no longer breaks its border when text wraps (marker
  sits in a fixed column, input flexes beside it).

### Fixed
- `/help` (and any first slash command) rendered nothing while the startup banner
  was still showing. The banner is now a permanent first item in the static
  region — removing it mid-run made Ink skip the newly appended item.
- `Tab` no longer both toggles auto-approve and completes a command when the
  autocomplete menu is open.

## [2.2.0] — 2026-06

### Fixed
- Default to English; only mirror the user's language once they switch.
- Shell output streams into scrollback (live and scrollable); single thinking
  indicator instead of duplicates.

### Changed
- English examples in the README; dropped the flaky downloads badge.

## [2.1.0] — 2026-06

### Added
- **Claude-Code-style UX** — `Esc` kills the running command, a message queue for
  typing while busy, double-`Esc` rewind to an earlier message, and no hard cap on
  tool rounds (a soft warning replaces it; `Esc` is the real brake).
- **Interactive setup wizard** — in-TUI onboarding (provider → endpoint → API key →
  model), replacing hand-edited config. `/setup` / `/config` reopen it.
- Version is read from `package.json`.

## [2.0.0] — 2026-06-21

### Added
- Initial public release of **termita 2.0** — a terminal copilot TUI.
- Copilot loop: propose → approve → execute → feed result back → react, one step
  at a time with the human in the loop.
- Approval policy with an allowlist and a loud danger guard (`rm -rf`, `mkfs`,
  `dd`, `curl | sh`, …) that always prompts even in auto-approve mode.
- Multi-provider support: OpenAI-compatible (LM Studio / Ollama / vLLM), OpenAI,
  and Anthropic.
- `npm`-installable (`npm i -g termita`), `termita init` and `termita doctor`
  helper subcommands.

[2.3.0]: https://github.com/andycufari/termita2/releases/tag/v2.3.0
[2.2.0]: https://github.com/andycufari/termita2/releases/tag/v2.2.0
[2.1.0]: https://github.com/andycufari/termita2/releases/tag/v2.1.0
[2.0.0]: https://github.com/andycufari/termita2/releases/tag/v2.0.0
