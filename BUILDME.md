# BUILDME — Termita 2.0

> Terminal copilot. A chat with a local LLM that lives **inside your terminal** and
> can operate the shell, one approved command at a time. Not an autonomous agent —
> a copilot. You drive, it rides shotgun.

This is a fresh project (new repo). The old Go/shell-hook `termita` is unrelated —
2.0 is a ground-up rewrite in Node as a TUI.

---

## 0. The one-paragraph pitch

You open `termita` in any terminal (your laptop, or `ssh` into a VPS). It's a chat.
You talk to a local model (LM Studio / Qwen). When something needs the system, the
model proposes **one** shell command, explains *what it does and why*, and waits.
You approve it (`Run` / `Edit` / `Always` / `No`). It runs, the **real output
streams into the chat**, the model reads the result and reacts. Then the turn is
yours again. Short, direct, hacker-chill replies. The whole thing is one Node
process you can `npm i -g` and run over SSH.

**It is a TUI, not a desktop app.** A terminal copilot you can't use from the
terminal is useless — and a desktop app would lock out every VPS/SSH workflow,
which is the main point.

---

## 1. Product principles (do not violate these)

1. **Copilot, not autopilot.** One command per proposal. The model does NOT chain
   10 commands and disappear. After each command runs (or is declined), control
   returns to the human. No multi-step autonomous task execution. If a goal needs
   several commands, the model proposes the *next* one and waits each time.
2. **Human in the driver's seat.** Every shell command that mutates anything is
   approved manually before it runs. The model never side-effects the system
   without an explicit OK for that action (modulo the allowlist the user builds).
3. **The terminal is the body.** Command output is not summarized away — the real
   stdout/stderr streams into the chat, live, line by line. The user sees what
   actually happened, not the model's paraphrase.
4. **Short and direct.** Personality: bro, chill, hacking vibes. Messages are
   short, precise, conversational. No corporate filler, no walls of text, no
   "Certainly! Here is...". Spanish or English — mirror the user.
5. **Local-first.** Talks to an OpenAI-compatible endpoint (LM Studio by default).
   No cloud, no API keys required (LM Studio ignores the key). Works offline.
6. **Portable & tiny.** Pure Node. Runs anywhere Node runs. `npm i -g termita`
   and go. No native build step, no compiler, no GUI libraries.

---

## 2. Target & runtime

- **Runtime:** Node.js ≥ 20 (uses native `fetch`, `ReadableStream`, `AbortController`).
- **Platform v1:** Linux (Ubuntu/KDE) + macOS. Designed to also run fine over SSH
  on a headless VPS. Windows = later (the shell tool assumes a POSIX `sh`).
- **Model (dev target):** **Qwen3.6-27B** served by **LM Studio** at
  `http://localhost:1234/v1` (OpenAI-compatible). Endpoint + model are configurable
  (see §7). LM Studio can be remote (e.g. a GPU box on the LAN) — point the endpoint
  at it.
- **TUI library:** [Ink](https://github.com/vadimdemedes/ink) (React for the
  terminal). Chosen because the UI is stateful and reactive — streaming text, live
  command output, and interactive approval cards all re-render from state. Ink runs
  clean over SSH.

---

## 3. The experience (what the user sees)

```
 ╭─ termita ──────────────────────────────────  qwen3.6-27b · lmstudio ─╮

 you  el puerto 8000 está ocupado, qué lo usa?

 term  dale, fijémonos quién lo tiene:

       ╭ shell ─────────────────────────────────────────────╮
       │ $ ss -tlnp | grep :8000                             │
       │ mira qué proceso escucha en el 8000                 │
       ╰────────────────────────────────────────────────────╯
        ▸ [R]un   [E]dit   [A]lways   [N]o

 you  ▸ Run

       LISTEN 0 128 127.0.0.1:8000 users:(("python3",pid=1921,fd=43))

 term  es un python3, pid 1921. lo mato?

 you  sí

 term  ╭ shell ─────────────────────────────────────────────╮
       │ $ kill 1921                                        │
       │ termina el proceso que ocupa el puerto             │
       ╰────────────────────────────────────────────────────╯
        ▸ [R]un   [E]dit   [A]lways   [N]o
 ...

 ╰─ /help · esc to interrupt ─────────────────────────────────────────╯
```

- Model text **streams token-by-token**.
- Command stdout/stderr **streams line-by-line** as it runs (you watch
  `npm install` scroll, a build compile, etc.).
- Approval is a card with single-key actions.
- Look: monospace, boxed, subtle color (brand / dim / danger / success). Hacker
  vibe, not noisy.

---

## 4. Architecture

One process. Three layers, cleanly separated so each is swappable and testable.

```
┌─────────────────────────────────────────────────────────────┐
│  UI layer  (Ink / React)                                     │
│   - renders the transcript (messages, tool cards, output)    │
│   - captures input, slash commands, approval keypresses      │
│   - subscribes to the engine's event stream                  │
├─────────────────────────────────────────────────────────────┤
│  Engine  (the copilot loop — pure logic, no UI imports)      │
│   - owns the message history                                 │
│   - calls the LLM (streaming), parses tool calls             │
│   - drives ONE tool call, then yields back to the user       │
│   - emits events: token, tool_proposed, tool_output, done... │
│   - awaits an approval decision from the UI before executing │
├─────────────────────────────────────────────────────────────┤
│  Providers + Tools                                           │
│   - provider: OpenAI-compatible streaming client (LM Studio) │
│   - tools: shell (exec), read, write, grep                   │
│   - policy: allowlist gate (Always rules), risk hints        │
│   - system: OS/shell/cwd facts for the system prompt (init)  │
└─────────────────────────────────────────────────────────────┘
```

**Key boundary:** the **engine emits events and awaits decisions**; the **UI
renders events and supplies decisions**. They talk through an async interface, not
direct calls. This is what keeps "streaming + interactive approval" sane: the
engine `await`s a Promise that the UI resolves when the user presses a key.

### The copilot loop (precise semantics — this is the heart)

```
loop(userText):
  history.push(user: userText)
  forever:
    resp = provider.streamComplete(system, history, tools)   # emits token events
    if resp has NO tool call:
        history.push(assistant: resp.text)
        RETURN  ──► turn is over, control back to user        # ← copilot, not agent
    # resp proposed exactly one tool call
    history.push(assistant: resp.toolCall)
    if tool is read-only (read/grep, or shell on allowlist):
        result = execute(tool)                                 # no prompt
    else:
        decision = await UI.approve(tool)                      # Run/Edit/Always/No
        switch decision:
          Run:    result = execute(tool)
          Always: policy.bless(tool); result = execute(tool)
          Edit:   tool = await UI.edit(tool); re-gate (continue inner)
          No:     result = "user declined"
    history.push(tool_result: result)                          # feed result back
    # loop again so the model can READ the result and respond / propose next step
```

**Why it loops at all (vs. true single-shot):** the model must see the command's
output to be useful ("the port is held by pid 1921 → want me to kill it?"). So one
*command* triggers one round-trip to read its result. But it does **not** barrel
through a multi-command plan: after it reacts to the result, if it wants to do
*more* it must propose the next command, which re-enters approval. A safety cap
(`MAX_TURNS`, e.g. 16) bounds runaway loops. The control-return guarantee: **the
model never executes a second mutating command without the human seeing the first
one's result and the new proposal.**

---

## 5. Tools exposed to the model

Defined as OpenAI-style function tools. Keep the set small and sharp.

| Tool    | Args                            | Side-effect | Approval        |
|---------|---------------------------------|-------------|-----------------|
| `shell` | `command` (string), `why` (str) | runs `sh`   | **yes** (unless allowlisted) |
| `read`  | `path`, optional `range`        | none        | auto-run        |
| `grep`  | `pattern`, `path`, flags        | none        | auto-run        |
| `write` | `path`, `content`, `why`        | writes file | **yes**         |

Notes:
- `shell` is the workhorse. `read`/`grep`/`write` exist so the model doesn't shell
  out for routine FS work (cleaner, and read/grep can auto-run safely). The model
  CAN still do everything via `shell` if it wants; these are conveniences.
- Every `shell`/`write` proposal carries a one-line **`why`** the model must fill —
  shown on the approval card ("what this does and why"). Required by the product
  spec, so the schema makes `why` mandatory.
- `shell` runs via `sh -c <command>` in a child process, inheriting the user's
  `cwd` and a sanitized env. cwd is tracked across calls (a `cd` in one command
  persists — see §13 open questions).

### Tool schemas (authoritative — copy into the provider request)

```jsonc
// shell
{ "type":"function","function":{
  "name":"shell",
  "description":"Run ONE shell command on the user's machine and return its output. Use for anything that touches the system. Propose a single command; the user approves it before it runs.",
  "parameters":{"type":"object","properties":{
    "command":{"type":"string","description":"the exact command, run via: sh -c <command>"},
    "why":{"type":"string","description":"one short line: what this does and why you're running it (shown to the user)"}
  },"required":["command","why"]}
}}
// read
{ "type":"function","function":{
  "name":"read",
  "description":"Read a file from disk. Read-only, runs without approval.",
  "parameters":{"type":"object","properties":{
    "path":{"type":"string"},
    "range":{"type":"string","description":"optional line range like \"1-40\""}
  },"required":["path"]}
}}
// grep
{ "type":"function","function":{
  "name":"grep",
  "description":"Search file contents with a regex. Read-only, runs without approval.",
  "parameters":{"type":"object","properties":{
    "pattern":{"type":"string"},
    "path":{"type":"string","description":"file or dir to search (recursive for dirs)"},
    "ignoreCase":{"type":"boolean"}
  },"required":["pattern","path"]}
}}
// write
{ "type":"function","function":{
  "name":"write",
  "description":"Write content to a file (creates or overwrites). Mutating — requires approval.",
  "parameters":{"type":"object","properties":{
    "path":{"type":"string"},
    "content":{"type":"string"},
    "why":{"type":"string","description":"one short line: what and why (shown to the user)"}
  },"required":["path","content","why"]}
}}
```

---

## 6. Approval & policy (the safety model)

**Default mode (v1): approve every mutating command, with an allowlist.**

- `shell` and `write` → show approval card before running.
- `read` and `grep` → auto-run (read-only).
- Card actions:
  - **Run** — execute this once.
  - **Edit** — open the command in an inline editor; on save, **re-gate** the
    edited command (you can't edit past a future deny rule).
  - **Always** — add a rule to the allowlist so this *kind* of command auto-runs
    next time, then run it. (e.g. approving `ls -la` with Always blesses `ls`.)
  - **No** — decline; feed "user declined" back to the model so it can react.
- **Allowlist** = persisted rules (per first token / normalized command shape),
  stored in the config dir. The gate consults it before every `shell`. A small
  built-in **danger list** (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs, etc.)
  can never be silently auto-allowed — those always prompt with a loud warning.
- Approval is **interruptible**: `Esc` during streaming or at a prompt aborts the
  current turn (AbortController on the fetch + kill the child process).

---

## 7. Config & init

On first run (`termita init`, or auto on first launch if no config), capture system
facts and write a config file.

**Config location:** `~/.config/termita/config.json` (respect `XDG_CONFIG_HOME`).

```jsonc
{
  "llm": {
    "endpoint": "http://localhost:1234/v1",   // LM Studio OpenAI-compatible base
    "model": "qwen3.6-27b",                    // exact id from /v1/models
    "apiKey": "lm-studio",                     // ignored by LM Studio; field required
    "maxTokens": 4096,
    "reasoning": false                          // Qwen thinking on/off (see §8)
  },
  "ui": { "theme": "hacker" },
  "policy": { "allowlist": [], "autoRunReadOnly": true }
}
```

**System facts** (gathered at init, injected into the system prompt so the model
knows the machine it's on):
- OS + distro + version (`os.platform`, `/etc/os-release`)
- arch, hostname, current user, `$HOME`, `cwd`
- default shell (`$SHELL`), and whether common tools exist (git, docker, systemctl,
  node, python, etc. — a quick `which` sweep)
- package manager (apt/dnf/pacman/brew) inferred from distro

Store these in `~/.config/termita/system.json` so the prompt is cheap to build and
re-probable with `termita init --probe`.

---

## 8. The system prompt (personality + capabilities)

Built from a static persona + the live system facts. Sketch:

```
You are termita — a terminal copilot. You ride shotgun while the user drives.

PERSONALITY: direct, chill, hacker vibes, a bro who knows their shell. Short,
precise, conversational replies. No filler, no lectures, no walls of text. Mirror
the user's language (Spanish/English). A little dry humor is fine.

HOW YOU WORK:
- You are a COPILOT, not an autopilot. Propose ONE command at a time and wait.
  Never assume a command ran — you'll get its output back as a tool result, THEN
  you react or propose the next step.
- Before any shell command, fill `why` with one short line: what it does and why.
- Prefer the smallest, safest command that answers the question. Read before you
  write. Don't be destructive without making the risk obvious.
- When you have the answer, just say it — short. Don't propose a command you don't
  need.

THIS MACHINE:
- OS: {{os}} {{version}} ({{arch}}), host {{hostname}}, user {{user}}
- shell: {{shell}}, cwd: {{cwd}}, pkg manager: {{pkgmgr}}
- available: {{tool list}}
```

**Reasoning knob:** Qwen3.6 is a thinking model. When `reasoning:false`, send
`chat_template_kwargs:{enable_thinking:false}` to suppress the trace (faster, less
token burn — good default for a snappy copilot). When `reasoning:true`, let it
think and render "· thought for Ns" dim above the reply. Toggle live with
`/reasoning on|off`.

---

## 9. Slash commands

Typed at the prompt, start with `/`:

| Command              | Action                                                       |
|----------------------|--------------------------------------------------------------|
| `/quit`              | exit (also `Ctrl-C` twice)                                   |
| `/model [id]`        | list models from `/v1/models`; switch active model           |
| `/reasoning on\|off` | toggle the thinking trace                                    |
| `/clean`             | clear the transcript + history (fresh context)               |
| `/compact`           | summarize history into a short note, drop old turns (free context) |
| `/help`              | show commands + keybindings                                  |

`/compact` = ask the model to summarize the conversation so far into a compact note,
replace the old messages with that note. Keeps long sessions within the context
window. `/clean` = nuke history entirely.

---

## 10. Provider: OpenAI-compatible streaming client

- `POST {endpoint}/chat/completions` with `stream:true`.
- Parse SSE: each `data:` line is a JSON delta; accumulate
  `choices[0].delta.content` → emit token events; accumulate
  `choices[0].delta.tool_calls` (id, name, arguments-as-string-fragments) →
  assemble the tool call.
- `tool_choice:"auto"`, send the §5 `tools` array.
- **Thinking models:** with low `max_tokens`, tool_calls can come back truncated
  (empty) because the reasoning trace ate the budget. Keep `maxTokens` generous
  (≥4096) OR disable thinking. Some servers stream a separate
  `delta.reasoning_content` — capture it for the "thought for Ns" line, never feed
  it back.
- **Fallback parse:** if no native `tool_calls` arrive but the content looks like a
  tool call (small models sometimes emit it as text/JSON), recover it from content.
- `GET {endpoint}/models` for `/model` listing.
- One `AbortController` per request so `Esc` cancels mid-stream.

LM Studio specifics: ignores the API key but the header must be present; supports
`tools`/`tool_calls`; supports `chat_template_kwargs` passthrough for Qwen thinking.

---

## 11. Project layout

```
termita/
  package.json            # bin: "termita", type: module, deps: ink, react
  src/
    cli.js                # entry: parse argv (init|run|doctor), bootstrap
    app.jsx               # Ink root: transcript, input, approval card, slash UI
    engine/
      loop.js             # the copilot loop (§4) — emits events, awaits decisions
      events.js           # event types + a tiny emitter/async-queue
    providers/
      openai.js           # streaming OpenAI-compatible client (§10)
    tools/
      index.js            # tool registry + JSON schemas (§5)
      shell.js            # exec via sh -c, stream stdout/stderr, track cwd
      fs.js               # read / write / grep
    policy/
      gate.js             # allowlist + danger list, Resolve()/Bless()
    config/
      config.js           # load/save config.json
      system.js           # probe + render system facts (§7)
    prompt/
      system.js           # build the system prompt (persona + facts) (§8)
    ui/
      theme.js            # colors, box styles
      components.jsx      # Message, ToolCard, OutputStream, Spinner, ...
  BUILDME.md              # this file
  README.md
```

---

## 12. Build order (phased — each phase is runnable & demoable)

> Build mano a mano: each phase runs locally (the TUI in *your* terminal), you try
> it, we adjust, then move on. LM Studio (on the GPU box or local) is just the
> model server the endpoint points at.

- **Phase 0 — Skeleton.** `npm init`, Ink hello, `termita` bin runs and shows the
  empty chat frame with a working input box. No LLM yet. *Demo: it opens, you type,
  it echoes.*
- **Phase 1 — Chat + streaming.** Wire the OpenAI-compatible provider to LM Studio.
  Plain chat, token-by-token streaming, no tools. Persona system prompt + system
  facts. *Demo: you converse with Qwen, replies stream in, hacker vibe.*
- **Phase 2 — Shell tool + approval.** Add the `shell` tool, the copilot loop, the
  approval card (Run/Edit/Always/No), live command output streaming into the chat,
  result fed back to the model. *Demo: "what's on port 8000" → proposes → you Run →
  output streams → it reacts.*
- **Phase 3 — FS tools + policy.** Add `read`/`grep` (auto-run) + `write`
  (approval). Persist the allowlist; danger list. *Demo: it reads/greps freely,
  asks before writing, "Always ls" sticks.*
- **Phase 4 — Slash commands + config.** `/model /reasoning /clean /compact /quit
  /help`, `termita init` wizard, `termita doctor`. *Demo: switch model live, toggle
  thinking, compact a long chat.*
- **Phase 5 — Polish + package.** Theme pass, `Esc` interrupt everywhere, error
  hints (endpoint down, ctx exceeded), `npm i -g` global install, README. *Demo:
  install globally, `ssh` to a box, run it there.*

---

## 13. Open questions / decisions deferred

1. **cwd persistence across `shell` calls.** Either (a) detect `cd` and track cwd in
   the engine, or (b) run all commands in one long-lived `sh` session (PTY) so state
   (cwd, env, shell vars) naturally persists. (b) is more faithful to "a terminal"
   but heavier. *Lean: start with (a), upgrade to (b) if it feels wrong.*
2. **Danger list: hard-block vs. always-prompt.** Should `rm -rf /` be impossible,
   or just un-allowlistable (always prompts)? *Lean: always-prompt + a loud red
   warning; never silently block (the user is root of their own box).*
3. **Output truncation for the model.** Huge command output (e.g. a 10k-line log)
   shouldn't blow the context window when fed back. Cap what's sent to the model
   (head+tail, N KB) while still showing the user the full stream. *Need a limit.*
4. **Multi-line / interactive commands.** `vim`, `top`, `ssh` into another host,
   REPLs — commands that take over the TTY. v1: run non-interactively, document the
   limitation. Real PTY hand-off is a later feature.
5. **Windows support.** Deferred. Shell tool assumes POSIX `sh`.
6. **Secrets in output.** Command output (env dumps, tokens) gets fed to the model
   and, if the endpoint is remote, leaves the machine. Default LM Studio is local so
   it's fine; warn if the endpoint is non-localhost.

---

## 14. Definition of done (v1)

- `npm i -g termita` then `termita` opens a chat TUI in any terminal, incl. over SSH.
- Talks to LM Studio (Qwen3.6-27B) with token streaming.
- Proposes one command at a time with a `why`; you approve; output streams live;
  the model reacts. Never runs a mutating command without approval (modulo allowlist).
- `read`/`grep` auto-run; `write` asks. Allowlist persists. Danger commands warn.
- Slash commands work. Personality is short, direct, hacker-chill.
- Runs on Linux + macOS; usable on a headless VPS.
