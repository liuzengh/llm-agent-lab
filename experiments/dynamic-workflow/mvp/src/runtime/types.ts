import type { JsonSchema } from '../json.js';
import type { WorkflowLimits } from '../config.js';
import type { CapabilityRegistryApi, RuntimeCapabilityManifest } from '../capabilities/types.js';
import type { PermissionManager } from '../permissions.js';

export type WorkflowAgentOptions = {
  label?: string;
  schema?: JsonSchema;
  maxTurns?: number;
  capabilities?: string[];
};

export type WorkflowAgentRequest = {
  prompt: string;
  options?: WorkflowAgentOptions;
  phase?: string;
};

export type WorkflowInvocationRequest = {
  nameOrRef: string;
  args?: unknown;
  phase?: string;
};

export type WorkflowExecutor = (request: WorkflowInvocationRequest) => Promise<unknown>;

export type WorkflowRunEvent =
  | {
      type: 'capabilities';
      active: string[];
      failed: Array<{ id: string; error: string }>;
      at: string;
    }
  | { type: 'agent-start'; id: number; label: string; at: string; phase?: string }
  | { type: 'agent-end'; id: number; label: string; at: string; phase?: string }
  | { type: 'agent-error'; id: number; label: string; at: string; error: string; phase?: string }
  | { type: 'workflow-start'; id: number; name: string; depth: number; at: string; phase?: string }
  | { type: 'workflow-end'; id: number; name: string; depth: number; at: string; phase?: string }
  | { type: 'workflow-error'; id?: number; name?: string; depth?: number; at: string; error: string; phase?: string }
  | { type: 'phase'; title: string; depth: number; at: string }
  | { type: 'workflow-log'; message: string; depth: number; at: string; phase?: string }
  | { type: 'workflow-result'; at: string; result: unknown };

export type WorkflowExecutionResult = {
  result: unknown;
  events: WorkflowRunEvent[];
  metrics: {
    agentCalls: number;
    workflowCalls: number;
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
  };
};

export type AgentExecutor = (request: WorkflowAgentRequest) => Promise<unknown>;

export type SandboxLauncher = (paths: {
  workflowPath: string;
  argsPath?: string;
}) => {
  command: string;
  args: string[];
};

export type WorkflowRuntimeContext = {
  executor: AgentExecutor;
  limits: WorkflowLimits;
  registry: CapabilityRegistryApi;
  permissions: PermissionManager;
  manifest: RuntimeCapabilityManifest;
  workflowsDir: string;
  image?: string;
  timeoutMs?: number;
  launcher?: SandboxLauncher;
  onEvent?: (event: WorkflowRunEvent) => void;
};
