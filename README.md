# 🐜 termita

[![npm version](https://img.shields.io/npm/v/termita.svg)](https://www.npmjs.com/package/termita)
[![node](https://img.shields.io/node/v/termita.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/termita.svg)](./LICENSE)

> **Terminal copilot.** A chat with an LLM that lives *inside your terminal* and
> can operate the shell — one approved command at a time. Not an autonomous agent.
> A copilot. You drive, it rides shotgun.

```
 termita  ▸ terminal copilot

 ◆ you   port 8000 is taken, what's using it?

 ◇ term  let's see who's holding it:

   ╭ shell ─────────────────────────────╮
   │ $ ss -tlnp | grep :8000            │
   │ check which process listens on 8000│
   ╰────────────────────────────────────╯
   ▸ Run      run it once
     Edit     tweak the command
     Always   allowlist this kind
     No       decline
     · ↑↓ move · enter · or R/E/A/N · esc cancel
```

> termita mirrors your language — talk to it in English or Spanish and it replies
> in kind.

termita proposes **one** shell step, explains *what it does and why*, and waits.
You approve it. It runs, the **real output streams into the chat live**, the model
reads the result and reacts. Then it's your turn again. One Node process you can
run anywhere — including over SSH on a headless VPS.

- **Copilot, not autopilot** — every mutating command is approved by you (or by an
  allowlist you build). Dangerous commands (`rm -rf`, `dd`, `mkfs`, fork bombs…)
  always prompt loudly, even in auto-approve mode.
- **The terminal is the body** — real stdout/stderr streams in line-by-line, not a
  paraphrase.
- **Local-first, provider-flexible** — talks to any OpenAI-compatible endpoint
  (LM Studio, Ollama, vLLM…), or directly to **OpenAI** or **Anthropic**.
- **Portable & tiny** — pure Node, no native build, `npm i -g` and go.

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
| `/allow`             | list allowlist rules                            |
| `/websearch [key]`   | set/show Brave web-search key (`off` to clear)  |
| `/quit`              | exit (also Ctrl-C twice)                         |

### Web search

Give the model live web access with a [Brave Search API](https://api-dashboard.search.brave.com)
key: `/websearch <key>` (or set `BRAVE_API_KEY`). Once a key is set, the model
calls a read-only `websearch` tool on its own whenever an answer needs current
info — latest versions, release dates, recent events, unfamiliar errors — and
cites the URLs it used. Without a key the tool stays hidden from the model.

### Scrolling output

termita runs in the alternate screen (no resize ghosting), so it draws its own
scrollable transcript. Scroll with the **mouse wheel**, `PageUp`/`PageDown`,
`Ctrl+↑`/`Ctrl+↓`, `Home` (top) / `End` (latest). New output auto-follows the
bottom until you scroll up. To **select/copy** text, hold a modifier while
dragging — **Option** on macOS (iTerm2/Terminal.app), **Shift** on most Linux
terminals — which bypasses mouse capture for a native selection.

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
