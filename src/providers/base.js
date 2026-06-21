// Shared provider error + helpers.

export class ProviderError extends Error {
  constructor(message, { kind } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind; // 'connection' | 'http' | 'parse' | 'auth'
  }
}

// Resolve the API key: config value, else a provider-specific env var.
export function resolveApiKey(llm) {
  if (llm.apiKey && llm.apiKey.trim()) {
    // env var indirection: apiKey can be "env:OPENAI_API_KEY"
    const m = llm.apiKey.match(/^env:(.+)$/);
    if (m) return process.env[m[1]] || '';
    return llm.apiKey;
  }
  if (llm.provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (llm.provider === 'openai') return process.env.OPENAI_API_KEY || '';
  return process.env.OPENAI_API_KEY || 'lm-studio';
}

// Parse a Server-Sent-Events stream, calling onEvent(parsedJson) per data line.
export async function parseSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          onEvent(JSON.parse(payload));
        } catch { /* partial/garbage line — skip */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
