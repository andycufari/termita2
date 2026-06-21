// Provider factory: pick a client by config.llm.provider. All providers expose
// the same interface — streamComplete({system,messages,tools,...}) + listModels().
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { ProviderError } from './base.js';

export { ProviderError };

export function createProvider(llm) {
  switch (llm.provider) {
    case 'anthropic':
      return new AnthropicProvider(llm);
    case 'openai':
    case 'openai-compatible':
    case undefined:
    case '':
      return new OpenAIProvider(llm);
    default:
      // unknown provider string — default to OpenAI-compatible (most servers)
      return new OpenAIProvider(llm);
  }
}
