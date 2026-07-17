import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { validateWorkflowSource } from './validate-workflow.js';
import type {
  AgentExecutor,
  WorkflowAgentRequest,
  WorkflowExecutionResult,
  WorkflowInvocationRequest,
  WorkflowRunEvent,
  WorkflowRuntimeContext,
  SandboxLauncher,
} from './types.js';
import type { WorkflowLimits } from '../config.js';

type AgentRpcRequest = {
  id: number;
  method: 'agent';
  params: WorkflowAgentRequest;
};

type WorkflowRpcRequest = {
  id: number;
  method: 'workflow';
  params: WorkflowInvocationRequest;
};

type RpcRequest = AgentRpcRequest | WorkflowRpcRequest;

type SandboxEvent =
  | {
      event: 'result' | 'error';
      result?: unknown;
      error?: string;
    }
  | {
      event: 'phase';
      title: string;
    }
  | {
      event: 'log';
      message: string;
      phase?: string;
    };

type RuntimeState = {
  agentCalls: number;
  workflowCalls: number;
  activeAgents: number;
  agentQueue: Array<() => void>;
  events: WorkflowRunEvent[];
  startedAtMs: number;
  startedAt: string;
  onEvent?: (event: WorkflowRunEvent) => void;
};

type ProcessResult = {
  result?: unknown;
};

export async function runWorkflowInDocker(
  source: string,
  input: unknown,
  context: WorkflowRuntimeContext,
): Promise<WorkflowExecutionResult> {
  const state = createRuntimeState(context.onEvent);
  emitEvent(state, {
    type: 'capabilities',
    active: context.manifest.capabilities.map((capability) => capability.id),
    failed: context.manifest.failedCapabilities,
    at: new Date().toISOString(),
  });
  const workflowRoot = await fs.realpath(path.resolve(context.workflowsDir));
  const launcher = context.launcher ?? createDockerLauncher(context.image ?? 'dynamic-workflow-sandbox:local');
  const timeoutMs = context.timeoutMs ?? Math.max(120_000, context.limits.agentTimeoutMs * 2);

  const result = await executeWorkflowSource({
    source,
    input,
    depth: 0,
    name: 'root',
    executor: context.executor,
    limits: context.limits,
    timeoutMs,
    launcher,
    workflowRoot,
    state,
    emitTerminalEvent: true,
  });

  return buildExecutionResult(result, state);
}

export async function runSandboxProcess(options: {
  command: string;
  args: string[];
  executor: AgentExecutor;
  limits: WorkflowLimits;
  timeoutMs: number;
  workflowExecutor?: (request: WorkflowInvocationRequest) => Promise<unknown>;
  depth?: number;
  state?: RuntimeState;
  emitTerminalEvent?: boolean;
}): Promise<WorkflowExecutionResult> {
  const state = options.state ?? createRuntimeState();
  const depth = options.depth ?? 0;
  let finalResult: unknown;
  let workflowError: string | undefined;

  const child = spawn(options.command, options.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    workflowError = `Workflow timed out after ${options.timeoutMs}ms.`;
    child.kill('SIGKILL');
  }, options.timeoutMs);

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending: Promise<void>[] = [];

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message: RpcRequest | SandboxEvent;
    try {
      message = JSON.parse(line) as RpcRequest | SandboxEvent;
    } catch {
      emitEvent(state, {
        type: 'workflow-error',
        at: new Date().toISOString(),
        depth,
        error: `Invalid sandbox JSON: ${line}`,
      });
      return;
    }

    if ('event' in message) {
      if (message.event === 'result') {
        finalResult = message.result;
        if (options.emitTerminalEvent !== false) {
          emitEvent(state, { type: 'workflow-result', at: new Date().toISOString(), result: message.result });
        }
      } else if (message.event === 'error') {
        workflowError = message.error ?? 'Unknown workflow error.';
        if (options.emitTerminalEvent !== false) {
          emitEvent(state, {
            type: 'workflow-error',
            at: new Date().toISOString(),
            depth,
            error: workflowError,
          });
        }
      } else if (message.event === 'phase') {
        const title = String(message.title ?? '').slice(0, options.limits.maxLogChars);
        emitEvent(state, { type: 'phase', title, depth, at: new Date().toISOString() });
      } else if (message.event === 'log') {
        const messageText = truncateLog(String(message.message ?? ''), options.limits.maxLogChars);
        emitEvent(state, {
          type: 'workflow-log',
          message: messageText,
          phase: message.phase,
          depth,
          at: new Date().toISOString(),
        });
        console.log(`[workflow${message.phase ? `:${message.phase}` : ''}] ${messageText}`);
      }
      return;
    }

    pending.push(handleRpcRequest(message, {
      executor: options.executor,
      workflowExecutor: options.workflowExecutor,
      limits: options.limits,
      writeResponse: (response) => child.stdin.write(`${JSON.stringify(response)}\n`),
      state,
    }));
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });

  clearTimeout(timer);
  await Promise.allSettled(pending);

  if (workflowError) {
    throw new Error(workflowError);
  }
  if (exitCode !== 0) {
    throw new Error(`Sandbox exited with code ${exitCode}. Build the sandbox image with: docker build -t dynamic-workflow-sandbox:local sandbox`);
  }

  const finishedAtMs = Date.now();
  return buildExecutionResult(finalResult, state, finishedAtMs);
}

async function handleRpcRequest(
  request: RpcRequest,
  context: {
    executor: AgentExecutor;
    workflowExecutor?: (request: WorkflowInvocationRequest) => Promise<unknown>;
    limits: WorkflowLimits;
    writeResponse: (response: unknown) => void;
    state: RuntimeState;
  },
): Promise<void> {
  if (request.method === 'workflow') {
    if (!context.workflowExecutor) {
      context.writeResponse({ id: request.id, error: 'Saved workflow invocation is not configured.' });
      return;
    }
    try {
      const output = await context.workflowExecutor(request.params);
      context.writeResponse({ id: request.id, result: output });
    } catch (error) {
      context.writeResponse({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const callNumber = ++context.state.agentCalls;
  const label = request.params.options?.label ?? `agent-${callNumber}`;
  if (callNumber > context.limits.maxAgents) {
    context.writeResponse({ id: request.id, error: `Agent budget exceeded: ${callNumber} > ${context.limits.maxAgents}` });
    return;
  }

  if (request.params.prompt.length > context.limits.maxAgentInputChars) {
    context.writeResponse({ id: request.id, error: `Agent prompt is too large: ${request.params.prompt.length} chars.` });
    return;
  }

  await acquireAgentSlot(context.state, context.limits.maxConcurrency);
  emitEvent(context.state, {
    type: 'agent-start',
    id: callNumber,
    label,
    phase: request.params.phase,
    at: new Date().toISOString(),
  });
  try {
    const output = await withTimeout(
      context.executor(request.params),
      context.limits.agentTimeoutMs,
      `Agent "${label}" timed out.`,
    );
    const serialized = JSON.stringify(output);
    if (serialized.length > context.limits.maxAgentOutputChars) {
      throw new Error(`Agent output is too large: ${serialized.length} chars.`);
    }
    emitEvent(context.state, {
      type: 'agent-end',
      id: callNumber,
      label,
      phase: request.params.phase,
      at: new Date().toISOString(),
    });
    context.writeResponse({ id: request.id, result: output });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent(context.state, {
      type: 'agent-error',
      id: callNumber,
      label,
      phase: request.params.phase,
      at: new Date().toISOString(),
      error: message,
    });
    context.writeResponse({ id: request.id, error: message });
  } finally {
    releaseAgentSlot(context.state);
  }
}

async function executeWorkflowSource(options: {
  source: string;
  input?: unknown;
  depth: number;
  name: string;
  executor: AgentExecutor;
  limits: WorkflowLimits;
  timeoutMs: number;
  launcher: SandboxLauncher;
  workflowRoot?: string;
  state: RuntimeState;
  emitTerminalEvent: boolean;
}): Promise<unknown> {
  const validation = validateWorkflowSource(options.source, options.limits.maxScriptChars);
  if (!validation.ok) {
    throw new Error(`Workflow validation failed:\n${validation.errors.join('\n')}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-workflow-'));
  const workflowPath = path.join(tempDir, 'workflow.js');
  const argsPath = options.input === undefined ? undefined : path.join(tempDir, 'args.json');
  await fs.writeFile(workflowPath, validation.normalizedSource, 'utf8');
  if (argsPath) {
    const serializedArgs = JSON.stringify(options.input);
    if (serializedArgs.length > options.limits.maxAgentInputChars) {
      throw new Error(`Workflow arguments are too large: ${serializedArgs.length} chars.`);
    }
    await fs.writeFile(argsPath, serializedArgs, 'utf8');
  }

  const launched = options.launcher({ workflowPath, argsPath });
  try {
    const result = await runSandboxProcess({
      ...launched,
      executor: options.executor,
      limits: options.limits,
      timeoutMs: options.timeoutMs,
      depth: options.depth,
      state: options.state,
      emitTerminalEvent: options.emitTerminalEvent,
      workflowExecutor: async (request) => {
        if (!options.workflowRoot) {
          throw new Error('Saved workflow invocation requires a configured workflow directory.');
        }
        if (options.depth >= options.limits.maxWorkflowDepth) {
          throw new Error(
            `Workflow nesting depth exceeded: ${options.depth + 1} > ${options.limits.maxWorkflowDepth}`,
          );
        }

        const workflowCall = ++options.state.workflowCalls;
        if (workflowCall > options.limits.maxWorkflowCalls) {
          throw new Error(
            `Saved workflow budget exceeded: ${workflowCall} > ${options.limits.maxWorkflowCalls}`,
          );
        }
        const sourcePath = await resolveSavedWorkflow(options.workflowRoot, request.nameOrRef);
        const childSource = await fs.readFile(sourcePath, 'utf8');
        const childDepth = options.depth + 1;
        const name = path.basename(sourcePath, '.workflow.js');
        emitEvent(options.state, {
          type: 'workflow-start',
          id: workflowCall,
          name,
          depth: childDepth,
          phase: request.phase,
          at: new Date().toISOString(),
        });
        try {
          const childResult = await executeWorkflowSource({
            ...options,
            source: childSource,
            input: request.args,
            depth: childDepth,
            name,
            emitTerminalEvent: false,
          });
          const serializedResult = JSON.stringify(childResult) ?? 'null';
          if (serializedResult.length > options.limits.maxAgentOutputChars) {
            throw new Error(`Saved workflow output is too large: ${serializedResult.length} chars.`);
          }
          emitEvent(options.state, {
            type: 'workflow-end',
            id: workflowCall,
            name,
            depth: childDepth,
            phase: request.phase,
            at: new Date().toISOString(),
          });
          return childResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitEvent(options.state, {
            type: 'workflow-error',
            id: workflowCall,
            name,
            depth: childDepth,
            phase: request.phase,
            at: new Date().toISOString(),
            error: message,
          });
          throw error;
        }
      },
    });
    return result.result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function resolveSavedWorkflow(workflowRoot: string, nameOrRef: string): Promise<string> {
  if (!nameOrRef.trim() || path.isAbsolute(nameOrRef) || nameOrRef.includes('\0')) {
    throw new Error(`Invalid saved workflow reference: ${nameOrRef}`);
  }
  const relativeRef = nameOrRef.endsWith('.js') ? nameOrRef : `${nameOrRef}.workflow.js`;
  const candidate = path.resolve(workflowRoot, relativeRef);
  const real = await fs.realpath(candidate);
  if (real !== workflowRoot && !real.startsWith(`${workflowRoot}${path.sep}`)) {
    throw new Error(`Saved workflow reference escapes the workflow directory: ${nameOrRef}`);
  }
  return real;
}

function createDockerLauncher(image: string): SandboxLauncher {
  return ({ workflowPath, argsPath }) => ({
    command: 'docker',
    args: [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--cpus',
      '1',
      '--memory',
      '256m',
      '--pids-limit',
      '64',
      '--read-only',
      '--security-opt',
      'no-new-privileges',
      '-v',
      `${workflowPath}:/workflow.js:ro`,
      ...(argsPath ? ['-v', `${argsPath}:/args.json:ro`] : []),
      image,
      '/workflow.js',
      ...(argsPath ? ['/args.json'] : []),
    ],
  });
}

function createRuntimeState(onEvent?: (event: WorkflowRunEvent) => void): RuntimeState {
  const startedAtMs = Date.now();
  return {
    agentCalls: 0,
    workflowCalls: 0,
    activeAgents: 0,
    agentQueue: [],
    events: [],
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    onEvent,
  };
}

function emitEvent(state: RuntimeState, event: WorkflowRunEvent): void {
  state.events.push(event);
  state.onEvent?.(event);
}

function buildExecutionResult(
  result: unknown,
  state: RuntimeState,
  finishedAtMs = Date.now(),
): WorkflowExecutionResult {
  return {
    result,
    events: state.events,
    metrics: {
      agentCalls: state.agentCalls,
      workflowCalls: state.workflowCalls,
      startedAt: state.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      elapsedMs: finishedAtMs - state.startedAtMs,
    },
  };
}

async function acquireAgentSlot(state: RuntimeState, maxConcurrency: number): Promise<void> {
  if (state.activeAgents < maxConcurrency) {
    state.activeAgents++;
    return;
  }
  await new Promise<void>((resolve) => state.agentQueue.push(resolve));
  state.activeAgents++;
}

function releaseAgentSlot(state: RuntimeState): void {
  state.activeAgents--;
  state.agentQueue.shift()?.();
}

function truncateLog(message: string, maxChars: number): string {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, Math.max(0, maxChars - 12))}…[truncated]`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
