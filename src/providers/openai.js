// OpenAI-compatible streaming client. Works with LM Studio, Ollama, vLLM, and
// OpenAI itself. Parses SSE, assembles tool_calls from streamed fragments,
// captures reasoning_content separately.
import { ProviderError, resolveApiKey, parseSSE, hash } from './base.js';

const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

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

  // Stream a completion. Calls handlers as data arrives:
  //   onToken(text), onReasoning(text)
  // Returns { text, reasoning, toolCalls: [{id,name,arguments(parsed)}] }
  async streamComplete({ system, messages, tools, signal, onToken, onReasoning }) {
    const body = {
      model: this.llm.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      max_tokens: this.llm.maxTokens ?? 4096,
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
      throw new ProviderError(`can't reach ${this.base} — is ${this.label} up?`, { kind: 'connection' });
    }

    if (res.status === 401) throw new ProviderError('401 unauthorized — check your API key', { kind: 'auth' });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new ProviderError(`HTTP ${res.status} from /chat/completions${detail ? `: ${detail}` : ''}`, { kind: 'http' });
    }

    let fullText = '';
    let reasoning = '';
    const toolAcc = new Map(); // index -> { id, name, args }

    await parseSSE(res.body, (json) => {
      const choice = json.choices?.[0];
      if (!choice) return;
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

    return { text: fullText, reasoning, toolCalls };
  }
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
