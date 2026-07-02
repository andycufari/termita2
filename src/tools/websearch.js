// Web search via the Brave Search API. Read-only (no system mutation), so it
// auto-runs without approval like read/grep. The API key comes from config
// (search.braveApiKey) with a BRAVE_API_KEY env fallback — resolved by the
// caller and passed in as ctx.braveApiKey. Returns a compact, model-friendly
// list of results (title · url · snippet) plus any instant answer Brave gives.
//
// Brave "Data for AI" / Web Search endpoint:
//   GET https://api.search.brave.com/res/v1/web/search?q=...&count=...
//   header: X-Subscription-Token: <key>
// Docs: https://api-dashboard.search.brave.com/app/documentation

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const TIMEOUT_MS = 15000;

export async function webSearch(query, opts = {}) {
  const key = opts.braveApiKey;
  if (!key) {
    return { output: 'error: no Brave API key set — run /websearch <key>', meta: { error: true } };
  }
  const q = String(query || '').trim();
  if (!q) return { output: 'error: empty search query', meta: { error: true } };

  const count = Math.min(MAX_COUNT, Math.max(1, opts.count || DEFAULT_COUNT));
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&count=${count}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  // chain the engine's interrupt signal so Esc cancels an in-flight search too
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { output: '[search interrupted]', meta: { interrupted: true } };
    }
    return { output: `error: brave search request failed: ${err.message}`, meta: { error: true } };
  }
  clearTimeout(timer);

  if (!res.ok) {
    // surface Brave's own error hints (401 = bad key, 429 = rate limit, etc.)
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const hint =
      res.status === 401 ? ' (bad/expired API key — check /websearch)' :
      res.status === 429 ? ' (rate limited — Brave free tier is ~1 req/sec)' : '';
    return {
      output: `error: brave search HTTP ${res.status}${hint}${detail ? `\n${detail}` : ''}`,
      meta: { error: true, status: res.status },
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { output: `error: could not parse brave response: ${err.message}`, meta: { error: true } };
  }

  return { output: formatResults(q, data), meta: { query: q } };
}

// Turn Brave's JSON into a tight text block the model can read cheaply.
function formatResults(query, data) {
  const lines = [];

  // Instant answer / knowledge panel, when present.
  const infobox = data?.infobox?.results?.[0] || data?.infobox;
  if (infobox?.long_desc || infobox?.description) {
    lines.push(`answer: ${clean(infobox.long_desc || infobox.description)}`);
    lines.push('');
  }

  const results = data?.web?.results || [];
  if (results.length === 0) {
    return lines.length ? lines.join('\n') : `(no web results for "${query}")`;
  }

  results.forEach((r, i) => {
    const title = clean(r.title) || '(untitled)';
    const url = r.url || '';
    const snippet = clean(r.description || '');
    const age = r.age || r.page_age ? ` · ${r.age || r.page_age}` : '';
    lines.push(`${i + 1}. ${title}${age}`);
    if (url) lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  });

  return lines.join('\n');
}

// Strip Brave's <strong> highlight tags + collapse whitespace.
function clean(s) {
  if (!s) return '';
  return String(s).replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
