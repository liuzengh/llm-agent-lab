import { OpenAIProvider, Runner, setTracingDisabled } from '@openai/agents';
import type { ModelConfig } from './config.js';

export function createModelProvider(config: ModelConfig): OpenAIProvider {
  setTracingDisabled(true);

  return new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    useResponses: false,
    strictFeatureValidation: true,
  });
}

export function createRunner(config: ModelConfig, workflowName = 'dynamic-workflow-mvp'): Runner {
  return new Runner({
    modelProvider: createModelProvider(config),
    tracingDisabled: true,
    workflowName,
  });
}
