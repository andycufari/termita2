// Onboarding wizard — interactive LLM setup inside the TUI. Steps:
//   provider -> endpoint (compat only) -> apiKey (cloud only) -> model -> done
// Re-runnable via /setup. Saves to config.json on finish.
import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme, glyphs } from './theme.js';
import { Spinner } from './components.jsx';
import { createProvider } from '../providers/index.js';

const PROVIDERS = [
  { id: 'openai-compatible', label: 'Local / OpenAI-compatible', hint: 'LM Studio · Ollama · vLLM — runs on your machine/LAN, no key', defEndpoint: 'http://localhost:1234/v1', needsKey: false, needsEndpoint: true },
  { id: 'openai', label: 'OpenAI', hint: 'GPT models — needs an API key (sk-…)', defEndpoint: '', needsKey: true, needsEndpoint: false },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'Claude models — needs an API key (sk-ant-…)', defEndpoint: '', needsKey: true, needsEndpoint: false },
];

export default function Setup({ initial, onDone, onCancel }) {
  const [step, setStep] = useState('provider'); // provider|endpoint|apikey|model|saving
  const [provIdx, setProvIdx] = useState(() => {
    const i = PROVIDERS.findIndex((p) => p.id === (initial?.provider || 'openai-compatible'));
    return i < 0 ? 0 : i;
  });
  const provider = PROVIDERS[provIdx];

  const [endpoint, setEndpoint] = useState(initial?.endpoint || '');
  const [apiKey, setApiKey] = useState(initial?.apiKey && initial.apiKey !== 'lm-studio' ? initial.apiKey : '');
  const [model, setModel] = useState(initial?.model || '');

  const [models, setModels] = useState(null); // null=not fetched, []=none, [...]=list
  const [modelIdx, setModelIdx] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState(null);
  const [manualModel, setManualModel] = useState(false);

  // ---- step: provider (arrow select) ----
  useInput((input, key) => {
    if (key.escape) { onCancel?.(); return; }
    if (step === 'provider') {
      if (key.upArrow) setProvIdx((i) => (i - 1 + PROVIDERS.length) % PROVIDERS.length);
      else if (key.downArrow) setProvIdx((i) => (i + 1) % PROVIDERS.length);
      else if (key.return) advanceFromProvider();
    } else if (step === 'model' && !manualModel) {
      if (models && models.length) {
        if (key.upArrow) setModelIdx((i) => (i - 1 + models.length) % models.length);
        else if (key.downArrow) setModelIdx((i) => (i + 1) % models.length);
        else if (key.return) { setModel(models[modelIdx]); finish(models[modelIdx]); }
        else if (input === 'm') setManualModel(true);
      }
    }
  }, { isActive: step === 'provider' || (step === 'model' && !manualModel) });

  const advanceFromProvider = useCallback(() => {
    const p = PROVIDERS[provIdx];
    if (!endpoint && p.defEndpoint) setEndpoint(p.defEndpoint);
    if (p.needsEndpoint) setStep('endpoint');
    else if (p.needsKey) setStep('apikey');
    else gotoModel(p, endpoint || p.defEndpoint, apiKey);
  }, [provIdx, endpoint, apiKey]);

  // ---- fetch models when entering the model step ----
  const gotoModel = useCallback(async (p, ep, key) => {
    setStep('model');
    setFetching(true);
    setFetchErr(null);
    try {
      const prov = createProvider({ provider: p.id, endpoint: ep, apiKey: key || 'lm-studio' });
      const list = await prov.listModels();
      setModels(list);
      setModelIdx(0);
      if (!list.length) setManualModel(true);
    } catch (err) {
      setFetchErr(err.message);
      setManualModel(true); // fall back to typing it
      setModels([]);
    } finally {
      setFetching(false);
    }
  }, []);

  const submitEndpoint = useCallback((val) => {
    const ep = (val || '').trim() || provider.defEndpoint;
    setEndpoint(ep);
    if (provider.needsKey) setStep('apikey');
    else gotoModel(provider, ep, apiKey);
  }, [provider, apiKey, gotoModel]);

  const submitApiKey = useCallback((val) => {
    const k = (val || '').trim();
    setApiKey(k);
    gotoModel(provider, endpoint || provider.defEndpoint, k);
  }, [provider, endpoint, gotoModel]);

  const submitManualModel = useCallback((val) => {
    const m = (val || '').trim();
    if (!m) return;
    setModel(m);
    finish(m);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = useCallback((chosenModel) => {
    setStep('saving');
    const p = PROVIDERS[provIdx];
    const llm = {
      provider: p.id,
      endpoint: p.needsEndpoint ? (endpoint || p.defEndpoint) : (endpoint || ''),
      model: chosenModel || model,
      apiKey: p.needsKey ? (apiKey || '') : (apiKey || 'lm-studio'),
    };
    onDone?.(llm);
  }, [provIdx, endpoint, apiKey, model, onDone]);

  // --- render ---
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={2} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>{glyphs.bolt} termita setup</Text>
      <Text color={theme.dim}>let's point termita at a model. esc to cancel.</Text>
      <Box height={1} />

      {step === 'provider' && (
        <Box flexDirection="column">
          <Text color={theme.brand}>where's your model?</Text>
          {PROVIDERS.map((p, i) => (
            <Box key={p.id} flexDirection="column">
              <Text color={i === provIdx ? theme.ok : theme.text} bold={i === provIdx}>
                {i === provIdx ? glyphs.bullet : ' '} {p.label}
              </Text>
              {i === provIdx && <Text color={theme.dim}>    {p.hint}</Text>}
            </Box>
          ))}
          <Text color={theme.faint}>  ↑↓ move · enter select</Text>
        </Box>
      )}

      {step === 'endpoint' && (
        <Box flexDirection="column">
          <Text color={theme.brand}>endpoint URL (OpenAI-compatible base):</Text>
          <Text color={theme.dim}>LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434/v1</Text>
          <Box>
            <Text color={theme.accent}>{glyphs.prompt} </Text>
            <TextInput value={endpoint} onChange={setEndpoint} onSubmit={submitEndpoint} placeholder={provider.defEndpoint} />
          </Box>
          <Text color={theme.faint}>  enter to continue (blank = default)</Text>
        </Box>
      )}

      {step === 'apikey' && (
        <Box flexDirection="column">
          <Text color={theme.brand}>{provider.label} API key:</Text>
          <Text color={theme.dim}>
            {provider.id === 'anthropic' ? 'sk-ant-… · or leave blank to use $ANTHROPIC_API_KEY' : 'sk-… · or leave blank to use $OPENAI_API_KEY'}
          </Text>
          <Box>
            <Text color={theme.accent}>{glyphs.prompt} </Text>
            <TextInput value={apiKey} onChange={setApiKey} onSubmit={submitApiKey} mask="•" placeholder="(hidden)" />
          </Box>
          <Text color={theme.faint}>  enter to continue</Text>
        </Box>
      )}

      {step === 'model' && (
        <Box flexDirection="column">
          <Text color={theme.brand}>pick a model:</Text>
          {fetching && <Spinner label="fetching models…" />}
          {fetchErr && <Text color={theme.warn}>! couldn't list models ({fetchErr.slice(0, 60)}) — type it manually</Text>}
          {!fetching && !manualModel && models && models.length > 0 && (
            <Box flexDirection="column">
              {models.slice(0, 12).map((m, i) => (
                <Text key={m} color={i === modelIdx ? theme.ok : theme.text} bold={i === modelIdx}>
                  {i === modelIdx ? glyphs.bullet : ' '} {m}
                </Text>
              ))}
              {models.length > 12 && <Text color={theme.faint}>  …{models.length - 12} more (press m to type)</Text>}
              <Text color={theme.faint}>  ↑↓ move · enter select · m = type manually</Text>
            </Box>
          )}
          {!fetching && manualModel && (
            <Box flexDirection="column">
              <Box>
                <Text color={theme.accent}>{glyphs.prompt} </Text>
                <TextInput value={model} onChange={setModel} onSubmit={submitManualModel} placeholder="model id" />
              </Box>
              <Text color={theme.faint}>  enter to finish</Text>
            </Box>
          )}
        </Box>
      )}

      {step === 'saving' && <Text color={theme.ok}>{glyphs.check} saved — let's go</Text>}
    </Box>
  );
}
