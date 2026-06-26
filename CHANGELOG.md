# Changelog

All notable changes to **termita** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
