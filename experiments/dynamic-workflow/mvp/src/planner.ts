import { Agent, type Runner } from '@openai/agents';
import type { WorkflowLimits } from './config.js';
import type { RuntimeCapabilityManifest } from './capabilities/types.js';
import { validateWorkflowSource } from './runtime/validate-workflow.js';

export type ProviderRuntimeManifest = {
  apiMode: 'chat-completions';
  supportsFunctionTools: boolean;
  supportsStructuredOutputWithTools: boolean;
  unsupported: string[];
};

export type RuntimeManifest = {
  primitives: Array<{ signature: string; semantics: string }>;
  capabilities: RuntimeCapabilityManifest;
  savedWorkflows: string[];
  workspaceRoot: string;
  limits: WorkflowLimits;
  provider: ProviderRuntimeManifest;
};

export type GenerateWorkflowInput = {
  runner: Runner;
  model: string;
  description: string;
  manifest: RuntimeManifest;
};

export async function generateWorkflow(input: GenerateWorkflowInput): Promise<string> {
  const planner = new Agent({
    name: 'dynamic_workflow_planner',
    model: input.model,
    instructions: [
      'You generate JavaScript workflow scripts for a restricted runtime.',
      'Return only JavaScript, no markdown fence and no explanation.',
      'Available globals: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages), workflow(nameOrRef, args?), phase(title), log(msg).',
      'The script may use const/let, arrays, objects, JSON, Math, top-level await, functions, if statements, for...of loops, and return.',
      'The script must not import modules, access process/globalThis/fetch/require, use eval/Function, or touch files directly.',
      'An agent opts object may contain label, schema, maxTurns, and capabilities.',
      'capabilities must be an array of exact capability IDs from the runtime manifest. Never invent a capability.',
      'Omit capabilities for safe default workspace.read access; pass [] for a reasoning-only agent.',
      'Use parallel([() => taskA(), () => taskB()]) for heterogeneous tasks that join at one synchronization barrier.',
      'Use pipeline(items, ...stages) when each item should stream through multiple async stages without a barrier between stages.',
      'Use workflow(nameOrRef, args) only for a saved workflow named in the runtime manifest; nesting is limited by its budget.',
      'Call phase(title) to name the current monitoring group and log(msg) for concise narrator progress lines.',
      'Always include export const meta = { name, description } at the top.',
      'Prefer small structured schemas in agent options when downstream code consumes JSON.',
      'Return a JSON-serializable result appropriate to the user task.',
      'Do not use hosted tools, tool search, deferLoading, imports, network APIs, shell APIs, or filesystem APIs directly.',
    ].join('\n'),
  });

  const prompt = buildPlannerPrompt(input.description, input.manifest);
  const result = await input.runner.run(planner, prompt);
  const source = extractJavaScript(String(result.finalOutput ?? ''));
  const validation = validateWorkflowSource(source, input.manifest.limits.maxScriptChars);
  if (!validation.ok) {
    throw new Error(`Planner produced invalid workflow:\n${validation.errors.join('\n')}\n\n${source}`);
  }
  return source;
}

export function buildPlannerPrompt(description: string, manifest: RuntimeManifest): string {
  return [
    `User task: ${description}`,
    '',
    'Runtime manifest:',
    JSON.stringify(manifest, null, 2),
    '',
    'Design the smallest useful dynamic workflow for this task.',
    'Use parallelism only for independent work and pipeline only when item-level streaming is beneficial.',
    'If required capabilities are absent, return a workflow that clearly reports the limitation instead of inventing access.',
    `Keep the script below ${manifest.limits.maxScriptChars} characters.`,
  ].join('\n');
}

export function extractJavaScript(output: string): string {
  const fenced = output.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? output).trim();
}
