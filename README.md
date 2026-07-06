# 🏴‍☠️ termita 🇦🇷

[![npm version](https://img.shields.io/npm/v/termita.svg)](https://www.npmjs.com/package/termita)
[![node](https://img.shields.io/node/v/termita.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/termita.svg)](./LICENSE)

> **Local AI first copilot for your console.**

```
 🏴‍☠️  TERMITA  🇦🇷

 ████████╗███████╗██████╗ ███╗   ███╗██╗████████╗ █████╗
 ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██║╚══██╔══╝██╔══██╗
    ██║   █████╗  ██████╔╝██╔████╔██║██║   ██║   ███████║
    ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║██║   ██║   ██╔══██║
    ██║   ███████╗██║  ██║██║ ╚═╝ ██║██║   ██║   ██║  ██║
    ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝

 Local AI first copilot for your console
```

termita is a chat with a model that runs in your terminal and can operate the
shell. It proposes one command at a time, explains what it does and why, and
waits for you to approve it. The command runs, its real output streams into the
chat, the model reads the result and responds. Then it's your turn again. One
Node process, runnable over SSH on a headless box.

It talks to a local model by default — LM Studio, Ollama, or anything speaking
the OpenAI-compatible API — and can also point at OpenAI or Anthropic.

> termita replies in the language you write to it — English or Spanish.

- Every command that changes something is approved by you, or by an allowlist you
  build. `rm -rf`, `dd`, `mkfs`, fork bombs and the like always prompt, even in
  auto-approve mode.
- Real stdout/stderr streams in line by line — you read what actually happened,
  not a summary of it.
- Runs against any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM…), or
  OpenAI / Anthropic directly.
- Pure Node, no native build. `npm i -g` and run it.

---

## Requirements

- **Node.js ≥ 20** (uses native `fetch`, `ReadableStream`, `AbortController`)
- A model endpoint: a local server (LM Studio / Ollama), or an OpenAI / Anthropic
  API key.

Check Node:

```sh
node --version   # should be v20 or higher
```

---

## Install

### macOS / Linux (recommended)

```sh
npm install -g termita
termita
```

That's it. (If `termita` isn't found, make sure your npm global bin is on `$PATH` —
`npm bin -g` shows the dir.)

### Windows

termita's shell tool targets a POSIX shell (`sh`). On Windows, run it inside **WSL2**
(Ubuntu) or **Git Bash**, where `sh` is available:

```sh
# In WSL2 / Git Bash:
npm install -g termita
termita
```

Native PowerShell/cmd is not supported yet (the shell tool assumes `sh -c`).

### Over SSH (the main use case)

Install on the box, then just run it — termita is a TUI that works fine over SSH:

```sh
ssh you@your-vps
npm install -g termita
termita
```

### From source

```sh
git clone https://github.com/andycufari/termita2.git
cd termita2
npm install
npm run build
npm link          # makes `termita` available globally
termita
```

---

## First run & config

Just run `termita`. On first launch an **interactive setup wizard** walks you
through it — pick your provider (Local / OpenAI / Anthropic), enter the endpoint
or API key, and choose a model (fetched live from the server when possible). No
JSON editing required.

Re-run the wizard anytime with **`/setup`** inside termita.

Settings are saved to:

- **Config:** `~/.config/termita/config.json` (respects `$XDG_CONFIG_HOME`)
- **System facts:** `~/.config/termita/system.json` (re-probe with `termita init`)

```sh
termita doctor    # check provider, endpoint, model, node version
termita init      # re-probe system facts
```

You can still edit `config.json` by hand if you prefer — here's the shape:

### config.json

```jsonc
{
  "llm": {
    "provider": "openai-compatible",          // "openai-compatible" | "openai" | "anthropic"
    "endpoint": "http://localhost:1234/v1",   // base URL (for openai-compatible)
    "model": "your-model-id",
    "apiKey": "lm-studio",                     // ignored by LM Studio; required by OpenAI/Anthropic
    "maxTokens": 4096,
    "reasoning": false                          // thinking trace on/off (Qwen etc.)
  },
  "ui": { "theme": "neon" },
  "policy": { "allowlist": [], "autoRunReadOnly": true, "autoApprove": false }
}
```

### Provider presets

**LM Studio** (default — local, no key needed):

```jsonc
"llm": {
  "provider": "openai-compatible",
  "endpoint": "http://localhost:1234/v1",
  "model": "qwen3.6-27b",
  "apiKey": "lm-studio"
}
```
> Serving LM Studio on your LAN? Enable **"Serve on Local Network"** (binds
> `0.0.0.0`) and open the port, then point `endpoint` at `http://<host>:1234/v1`.

**Ollama** (local):

```jsonc
"llm": {
  "provider": "openai-compatible",
  "endpoint": "http://localhost:11434/v1",
  "model": "llama3.1",
  "apiKey": "ollama"
}
```

**OpenAI:**

```jsonc
"llm": {
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-..."        // or set OPENAI_API_KEY in your env
}
```

**Anthropic (Claude):**

```jsonc
"llm": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "sk-ant-..."    // or set ANTHROPIC_API_KEY in your env
}
```

> API keys can come from the config **or** environment variables
> (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — env wins if both are set.

---

## Using it

You chat. When something needs the system, termita proposes a command and waits.

### Approval

| Action     | Key   | What it does                                       |
|------------|-------|----------------------------------------------------|
| **Run**    | `R`   | run this step once                                 |
| **Edit**   | `E`   | tweak the command inline, then re-gate it          |
| **Always** | `A`   | allowlist this *kind* of command, then run it      |
| **No**     | `N`   | decline; the model is told and reacts              |

Navigate with **↑ / ↓** and **Enter**, or hit the letter directly.

**Auto-approve mode** (`TAB` or `/auto`): commands run without asking — *except*
dangerous patterns, which always prompt with a red warning. File writes auto-run too.

**Esc** interrupts anything: a streaming reply, a running command, or a prompt.

### Run a command yourself — `:`

Type a line starting with `:` to run a command **directly** — no model round-trip,
no approval prompt. You see the full, real output stream in; the model is then
handed the *trimmed* version so it stays in sync with what happened (a `cd`, an
install, a config edit) without blowing the context.

```
you  › :ls -la
      (full output streams in)
you  › :git status
```

Full-screen programs work too. `:vim notes.txt`, `:htop`, `:less big.log`,
`:lazygit` — termita **suspends**, hands the whole terminal to the program (so
it's fully interactive, exactly as if you'd typed it in your shell), and redraws
itself when you quit. The model can't see inside those (there's no output to
capture) — it's just told you ran it.

### Slash commands

| Command              | Action                                          |
|----------------------|-------------------------------------------------|
| `/help`              | show commands + keys                            |
| `/setup`             | re-run the provider / model setup wizard        |
| `/model [id]`        | list models / switch the active model           |
| `/reasoning on\|off` | toggle the thinking trace                        |
| `/auto`              | toggle auto-approve (same as TAB)               |
| `/clean`             | wipe transcript + history (fresh context)       |
| `/compact`           | summarize history into a note, free context     |
| `/context [n]`       | show / set the model context window (gauge)     |
| `/mouse [on\|off]`   | wheel-scroll vs native drag-select / copy       |
| `/memory […]`        | show / manage what termita remembers            |
| `/cognito [on\|off]` | incognito — no memory saved or recalled         |
| `/allow`             | list allowlist rules                            |
| `/websearch [key]`   | set/show Brave web-search key (`off` to clear)  |
| `/credits`           | who made this                                   |
| `/quit`              | exit (also Ctrl-C twice)                         |

### Memory

termita can remember durable facts you can't discover by running a command — a
preference, a project detail, a constraint. Just tell it:

```
you  › remember I use pnpm here and deploy with fly
term › noted.   → memory: "Uses pnpm; deploys via fly.io"
```

The model distills what you said into one line and saves it (via a `memory`
tool, no approval needed). Notes are **project-scoped** by default (tied to the
current directory) or **global** (machine-wide prefs). Saved notes are shown to
the model at the top of every turn, so it stops re-asking.

Manage them by hand too:

```
/memory                 list active notes (global + this project)
/memory add <note>      save a project note   (add -g for a global one)
/memory forget <n>      drop note #n
/memory clear           wipe everything
```

Stored at `~/.config/termita/memory.json`. termita does **not** auto-save things
it can probe (whether a tool is installed, a service is running) — it runs a
command for those.

**Incognito:** `/cognito on` is a session blackout — nothing is saved *and*
nothing is recalled, so the model runs as if memory were empty. `/cognito off`
brings it back. Resets to off each launch. The footer shows 🕶️ while it's on.

### Web search

Give the model live web access with a [Brave Search API](https://api-dashboard.search.brave.com)
key: `/websearch <key>` (or set `BRAVE_API_KEY`). Once a key is set, the model
calls a read-only `websearch` tool on its own whenever an answer needs current
info — latest versions, release dates, recent events, unfamiliar errors — and
cites the URLs it used. Without a key the tool stays hidden from the model.

### Scrolling output

termita runs in the alternate screen (no resize ghosting), so it draws its own
scrollable transcript. Scroll with the **mouse wheel**, `PageUp`/`PageDown`,
`Ctrl+↑`/`Ctrl+↓`, `Home` (oldest) / `End` (latest) — it scrolls by rows, so the
wheel moves evenly and `Home` lands on real history instead of a blank top. New
output auto-follows the bottom until you scroll up.

To **select/copy** text with the mouse while wheel-scroll is on, hold a modifier
while dragging — **Option** on macOS (iTerm2/Terminal.app), **Shift** on most
Linux terminals. Prefer plain drag-to-select? Run **`/mouse off`** to release
mouse capture (native selection + copy-paste work everywhere; the wheel then uses
your terminal's own scrollback). **`/mouse on`** brings wheel-scroll back. The
setting persists.

---

## Safety model

- `shell` and `write` ask before running; `read` and `grep` auto-run (read-only).
- **Allowlist** is persisted per normalized command shape. Broad/slow commands
  (`find`, `du`, `tar`, `rsync`…) key on command + path, so blessing `find .`
  does **not** also bless `find /`.
- A built-in **danger list** (`rm -rf`, `mkfs`, `dd of=/dev/…`, fork bombs,
  `curl | sh`, destructive git, …) can never be silently auto-allowed — it always
  prompts with a loud warning, even in auto-approve.
- **Remote endpoints:** command output is fed back to the model. If your endpoint
  is non-local, that output leaves your machine. Keep it local (LM Studio/Ollama)
  for fully offline use.

---

## Architecture

Three clean layers, each swappable and testable:

```
UI (Ink/React)        renders the transcript, captures input + approval keys
Engine                the copilot loop — owns history, drives the LLM, runs ONE
                      tool per round, awaits a human decision, feeds result back
Providers + Tools     streaming clients (OpenAI-compatible / OpenAI / Anthropic),
                      the shell/read/write/grep tools, the approval gate
```

The engine **emits events and awaits decisions**; the UI **renders events and
supplies decisions**. They talk through an async interface, never direct calls.

```
src/
  cli.js              entry: init | doctor | TUI
  app.jsx             Ink root
  engine/             copilot loop + event bus
  providers/          openai.js, anthropic.js + a factory
  tools/              shell (live stream + cwd), fs (read/write/grep), schemas
  policy/gate.js      allowlist + danger list + auto-approve
  config/             config.json + system probe
  prompt/system.js    persona + machine facts
  ui/                 theme, components, banner
build.js              esbuild bundle → dist/cli.js
```

---

## Development

```sh
npm run build     # bundle src → dist/cli.js
npm run dev       # build + run
npm start         # run the built bundle
```

---

## License

MIT
