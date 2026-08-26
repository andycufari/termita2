// OpenAI-compatible streaming client. Works with LM Studio, Ollama, vLLM, and
// OpenAI itself. Parses SSE, assembles tool_calls from streamed fragments,
// captures reasoning_content separately.
import { ProviderError, resolveApiKey, parseSSE, hash } from './base.js';

const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

// Did this request carry an image part? (used to give a vision-specific error)
function hadImage(body) {
  for (const m of body?.messages || []) {
    if (Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')) return true;
  }
  return false;
}

export class OpenAIProvider {
  constructor(llm) {
    this.llm = llm; // { provider, endpoint, model, apiKey, maxTokens, reasoning }
    this.isOpenAI = llm.provider === 'openai';
  }

  get base() {
    const ep = this.llm.endpoint || (this.isOpenAI ? OPENAI_DEFAULT_ENDPOINT : 'http://localhost:1234/v1');
    return ep.replace(/\/+$/, '');
  }

  get label() {
    return this.isOpenAI ? 'OpenAI' : 'the endpoint';
  }

  headers() {
    const key = resolveApiKey(this.llm) || 'lm-studio';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    };
  }

  async listModels() {
    let res;
    try {
      res = await fetch(`${this.base}/models`, { headers: this.headers() });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ProviderError(`can't reach ${this.base} — is ${this.label} up?`, { kind: 'connection' });
    }
    if (res.status === 401) throw new ProviderError('401 unauthorized — check your API key', { kind: 'auth' });
    if (!res.ok) throw new ProviderError(`/models -> HTTP ${res.status}`, { kind: 'http' });
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  // Best-effort: ask the server for the loaded model's context window so the
  // footer gauge reflects reality instead of the 8k default. LM Studio's native
  // /api/v0/models returns `loaded_context_length` / `max_context_length` per
  // model; the OpenAI /v1/models shape sometimes carries `context_length` too.
  // Returns a positive integer, or null if we can't tell (caller keeps its
  // configured value). Never throws — this is a nicety, not a hard dependency.
  async detectContextLength(modelId) {
    const id = modelId || this.llm.model;
    // Prefer LM Studio's richer native endpoint; the OpenAI base is the parent
    // of /v1, so swap the trailing /v1 for /api/v0 when present.
    const nativeBase = this.base.replace(/\/v1$/, '/api/v0');
    for (const url of [`${nativeBase}/models`, `${this.base}/models`]) {
      try {
        const res = await fetch(url, { headers: this.headers() });
        if (!res.ok) continue;
        const data = await res.json();
        const list = data.data || data.models || [];
        const hit = list.find((m) => (m.id || m.key) === id) || list.find((m) => m.state === 'loaded');
        const n = pickContextLength(hit);
        if (n) return n;
      } catch {
        // try the next url / give up quietly
      }
    }
    return null;
  }

  // Stream a completion. Calls handlers as data arrives:
  //   onToken(text), onReasoning(text)
  // Returns { text, reasoning, toolCalls: [{id,name,arguments(parsed)}] }
  // `maxTokens` overrides the configured reply budget for ONE call. Used by
  // compact(), whose summary replaces the entire history and so must not be
  // capped by the (much smaller) budget meant for chat replies.
  async streamComplete({ system, messages, tools, signal, onToken, onReasoning, maxTokens }) {
    const body = {
      model: this.llm.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      max_tokens: maxTokens ?? this.llm.maxTokens ?? 4096,
      tools,
      tool_choice: 'auto',
    };
    // Qwen thinking toggle — only for OpenAI-compatible local servers (LM Studio
    // passes chat_template_kwargs through). OpenAI proper rejects unknown params.
    if (!this.isOpenAI && this.llm.reasoning === false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    let res;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Don't blame the endpoint for every fetch failure — a slow local model
      // (big context, cold load) surfaces as a TIMEOUT, not a refused socket,
      // and "is it up?" sends you debugging a server that's fine. Report what
      // actually happened; keep the reachability hint for real connect errors.
      const code = err.cause?.code || err.code;
      if (err.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
        throw new ProviderError(
          `${this.label} didn't respond in time — the model may still be loading or generating. Try a smaller model, or lower contextSize.`,
          { kind: 'timeout' },
        );
      }
      const why = code ? ` (${code})` : '';
      throw new ProviderError(`can't reach ${this.base}${why} — is ${this.label} up?`, { kind: 'connection' });
    }

    if (res.status === 401) throw new ProviderError('401 unauthorized — check your API key', { kind: 'auth' });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      // LM Studio commonly 400s with "Failed to load model …" when the configured
      // model isn't loaded — surface a clear, actionable line instead of raw JSON.
      if (/failed to load model/i.test(detail)) {
        throw new ProviderError(
          `model "${this.llm.model}" isn't loaded on ${this.label} — load it (LM Studio → the model), or run /model to pick one that is`,
          { kind: 'http' },
        );
      }
      // Image attached to a text-only model → the server rejects the image_url /
      // vision content. Point the user at loading a vision model.
      if (/image|vision|multimodal|content.*not.*support|unsupported content/i.test(detail) && hadImage(body)) {
        throw new ProviderError(
          `model "${this.llm.model}" has no vision — it can't read images. Load a vision model (e.g. a Qwen-VL / Llava in LM Studio), or send text/.md files instead`,
          { kind: 'http' },
        );
      }
      throw new ProviderError(`HTTP ${res.status} from /chat/completions${detail ? `: ${detail}` : ''}`, { kind: 'http' });
    }

    let fullText = '';
    let reasoning = '';
    const toolAcc = new Map(); // index -> { id, name, args }

    let finishReason = null;
    await parseSSE(res.body, (json) => {
      const choice = json.choices?.[0];
      if (!choice) return;
      // 'length' here = the model hit max_tokens mid-generation. For a thinking
      // model that can mean the reasoning trace ate the whole budget before any
      // visible text — the engine uses this to give an actionable message.
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (delta.content) {
        fullText += delta.content;
        onToken?.(delta.content);
      }
      // some servers stream a separate reasoning channel
      const rc = delta.reasoning_content ?? delta.reasoning;
      if (rc) {
        reasoning += rc;
        onReasoning?.(rc);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
    });

    let toolCalls = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id || `call_${Math.abs(hash(t.name + t.args))}`, name: t.name, arguments: safeParseArgs(t.args) }));

    // Fallback: small models sometimes emit a tool call as JSON in content.
    if (toolCalls.length === 0 && fullText.trim()) {
      const recovered = recoverToolFromText(fullText);
      if (recovered) {
        toolCalls = [recovered];
        fullText = ''; // it wasn't really prose
      }
    }

    // truncated = nothing to show, and it looks like the token budget was the
    // cause. The clean signal is finish_reason==='length', but many local servers
    // (LM Studio with some thinking models) DON'T send finish_reason at all —
    // there we fall back to "empty output + a reasoning trace was produced", which
    // is the thinking-ate-the-budget shape. Both point at maxTokens/reasoning.
    const nothingShown = !fullText.trim() && toolCalls.length === 0;
    const truncated = nothingShown && (finishReason === 'length' || (finishReason == null && reasoning.length > 0));
    return { text: fullText, reasoning, toolCalls, finishReason, truncated, reasoningLen: reasoning.length };
  }
}

// Pull a context-window size out of a model description, tolerating the several
// field names different servers use. Prefer the ACTUALLY-loaded length over the
// theoretical max so the gauge matches what the running model can hold.
function pickContextLength(m) {
  if (!m || typeof m !== 'object') return null;
  // llama.cpp / llama-server nests these under `meta`; LM Studio and vLLM put
  // them at the root. Look in both, root first.
  const src = [m, m.meta, m.model_info, m.details].filter((o) => o && typeof o === 'object');
  const FIELDS = [
    'loaded_context_length',
    'context_length',
    'max_context_length',
    'max_model_len',   // vLLM
    'n_ctx',           // llama.cpp — the length ACTUALLY loaded
    'context_window',
  ];
  for (const o of src) {
    for (const f of FIELDS) {
      const n = Number(o[f]);
      if (Number.isFinite(n) && n >= 256) return Math.floor(n);
    }
  }
  // Deliberately NOT considered: `n_ctx_train`. It's the length the model was
  // TRAINED at, not what the server loaded — a 27B served at n_ctx=131072 still
  // reports n_ctx_train=262144. Trusting it told one user they had 262k when the
  // real ceiling was half that, so the gauge read 34% at the moment the request
  // was actually about to be refused. If nothing above matched, return null and
  // keep the configured value rather than guessing high.
  return null;
}

function safeParseArgs(s) {
  if (!s || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    // try to salvage trailing-comma / truncated json
    try {
      return JSON.parse(s.replace(/,\s*}$/, '}').replace(/,\s*]$/, ']'));
    } catch {
      return { _raw: s, _parseError: true };
    }
  }
}

// Recover a tool call emitted as plain JSON text (small-model fallback).
function recoverToolFromText(text) {
  // look for {"name": "...", "arguments": {...}} or a tool-ish JSON blob
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let obj;
  try {
    obj = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  const name = obj.name || obj.tool || obj.function?.name;
  let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? obj.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* leave as-is */ }
  }
  const KNOWN = ['shell', 'read', 'grep', 'write'];
  if (!name || !KNOWN.includes(name)) return null;
  return { id: `call_${Math.abs(hash(name + JSON.stringify(args)))}`, name, arguments: args || {} };
}
