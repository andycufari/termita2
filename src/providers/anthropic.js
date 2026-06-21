// Anthropic (Claude) streaming client. The engine speaks OpenAI-format messages
// internally; this provider translates them to/from the Anthropic Messages API
// so the rest of termita doesn't care which backend it's talking to.
import { ProviderError, resolveApiKey, parseSSE, hash } from './base.js';

const ANTHROPIC_DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider {
  constructor(llm) {
    this.llm = llm;
  }

  get base() {
    return (this.llm.endpoint || ANTHROPIC_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  }

  headers() {
    const key = resolveApiKey(this.llm);
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  // Anthropic has no /models listing on the standard plan; return a curated set.
  async listModels() {
    try {
      const res = await fetch(`${this.base}/models`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json();
        const ids = (data.data || []).map((m) => m.id);
        if (ids.length) return ids;
      }
    } catch { /* fall through to static list */ }
    return [
      'claude-opus-4-1',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
    ];
  }

  // Same interface as OpenAIProvider.streamComplete.
  async streamComplete({ system, messages, tools, signal, onToken, onReasoning }) {
    const body = {
      model: this.llm.model,
      max_tokens: this.llm.maxTokens ?? 4096,
      stream: true,
      system,
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(tools),
    };
    // Extended thinking: Anthropic needs a budget; enable only when asked.
    if (this.llm.reasoning) {
      body.thinking = { type: 'enabled', budget_tokens: Math.min(2048, (this.llm.maxTokens ?? 4096) - 512) };
    }

    let res;
    try {
      res = await fetch(`${this.base}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ProviderError(`can't reach Anthropic at ${this.base}`, { kind: 'connection' });
    }

    if (res.status === 401) throw new ProviderError('401 unauthorized — check ANTHROPIC_API_KEY / apiKey', { kind: 'auth' });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new ProviderError(`HTTP ${res.status} from /messages${detail ? `: ${detail}` : ''}`, { kind: 'http' });
    }

    let fullText = '';
    let reasoning = '';
    // index -> { type, name, id, json } for content blocks
    const blocks = new Map();

    await parseSSE(res.body, (ev) => {
      switch (ev.type) {
        case 'content_block_start': {
          const b = ev.content_block || {};
          blocks.set(ev.index, { type: b.type, name: b.name, id: b.id, json: '' });
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          const blk = blocks.get(ev.index);
          if (d.type === 'text_delta') {
            fullText += d.text;
            onToken?.(d.text);
          } else if (d.type === 'thinking_delta') {
            reasoning += d.thinking || '';
            onReasoning?.(d.thinking || '');
          } else if (d.type === 'input_json_delta') {
            if (blk) blk.json += d.partial_json || '';
          }
          break;
        }
        default:
          break;
      }
    });

    const toolCalls = [...blocks.values()]
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({
        id: b.id || `call_${Math.abs(hash(b.name + b.json))}`,
        name: b.name,
        arguments: safeParse(b.json),
      }));

    return { text: fullText, reasoning, toolCalls };
  }
}

// --- translation: OpenAI-format <-> Anthropic ------------------------------

function toAnthropicTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// Convert the engine's OpenAI-format history to Anthropic's content-block format.
// - assistant tool_calls  -> assistant message with tool_use blocks
// - role:"tool" results   -> user message with tool_result blocks
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content || '' });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content && m.content.trim()) content.push({ type: 'text', text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: safeParse(tc.function.arguments),
          });
        }
      }
      out.push({ role: 'assistant', content: content.length ? content : (m.content || '') });
    } else if (m.role === 'tool') {
      // attach as tool_result; merge consecutive tool results into one user msg
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

function safeParse(s) {
  if (!s || typeof s !== 'string') return s || {};
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s, _parseError: true };
  }
}
