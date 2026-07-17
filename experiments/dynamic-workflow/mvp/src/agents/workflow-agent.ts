import { Agent, type JsonSchemaDefinition, type Runner } from '@openai/agents';
import type { CapabilityRegistryApi } from '../capabilities/types.js';
import { parseJsonFromText, validateJson } from '../json.js';
import type { AgentExecutor, WorkflowAgentRequest } from '../runtime/types.js';

export type WorkflowAgentExecutorOptions = {
  runner: Runner;
  model: string;
  registry: CapabilityRegistryApi;
};

export function createWorkflowAgentExecutor(options: WorkflowAgentExecutorOptions): AgentExecutor {
  return async (request: WorkflowAgentRequest) => {
    const selection = options.registry.select(request.options?.capabilities);
    const schema = request.options?.schema;
    const expectsJson = Boolean(schema);
    const instructions = [
      'You are a worker inside a dynamically generated workflow.',
      'Complete only the supplied task and distinguish observed evidence from inference.',
      `Enabled capabilities: ${selection.ids.length ? selection.ids.join(', ') : '(reasoning only)'}.`,
      'Use only the tools you were given. Never claim a tool action occurred unless you called it.',
      expectsJson
        ? 'Return only valid JSON matching the requested schema. Do not wrap it in markdown.'
        : 'Return a concise result suitable for the next workflow stage.',
    ].join('\n');
    const base = {
      name: safeAgentName(request.options?.label ?? 'workflow_worker'),
      model: options.model,
      instructions,
      tools: selection.tools,
    };

    const first = await runWorker(options.runner, new Agent(base), request);
    if (!schema) return first;

    try {
      return parseJsonFromText(String(first), schema);
    } catch (error) {
      const repairPrompt = [
        'Convert the supplied response into data matching this JSON schema.',
        `Schema: ${JSON.stringify(schema)}`,
        `Validation error: ${error instanceof Error ? error.message : String(error)}`,
        'Preserve only information present in the response. Return only the corrected data.',
        '',
        `Response:\n${String(first)}`,
      ].join('\n');
      const outputType: JsonSchemaDefinition = {
        type: 'json_schema',
        name: `${safeAgentName(request.options?.label ?? 'workflow')}_repair`,
        strict: true,
        schema: schema as JsonSchemaDefinition['schema'],
      };
      try {
        const formatter = new Agent({
          name: `${safeAgentName(request.options?.label ?? 'workflow')}_formatter`,
          model: options.model,
          instructions: 'Normalize supplied content into requested structured output. Do not add facts.',
          outputType,
        });
        const repaired = await runWorker(options.runner, formatter, {
          prompt: repairPrompt,
          options: { maxTurns: 2 },
        });
        return validateJson(repaired, schema);
      } catch {
        const textFormatter = new Agent({
          name: `${safeAgentName(request.options?.label ?? 'workflow')}_text_formatter`,
          model: options.model,
          instructions: 'Return only valid JSON matching the supplied schema. Do not use markdown.',
        });
        const repaired = await runWorker(options.runner, textFormatter, {
          prompt: repairPrompt,
          options: { maxTurns: 2 },
        });
        return parseJsonFromText(String(repaired), schema);
      }
    }
  };
}

async function runWorker(runner: Runner, agent: Agent<any, any>, request: WorkflowAgentRequest): Promise<unknown> {
  const maxTurns = Math.max(1, Math.min(request.options?.maxTurns ?? 8, 20));
  const result = await runner.run(agent, request.prompt, { maxTurns });
  return result.finalOutput ?? '';
}

function safeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'workflow_worker';
}
