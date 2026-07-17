import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  defaultLimits,
  loadModelConfig,
  loadProjectConfig,
  type ResolvedProjectConfig,
  type WorkflowLimits,
} from './config.js';
import { buildCapabilityRegistry } from './capabilities/registry.js';
import type { CapabilityRegistryApi } from './capabilities/types.js';
import { PermissionManager, type ApprovalPrompt, type PermissionRequest } from './permissions.js';
import { createRunner } from './provider.js';
import { generateWorkflow, type RuntimeManifest } from './planner.js';
import { createWorkflowAgentExecutor } from './agents/workflow-agent.js';
import { runWorkflowInDocker } from './runtime/host.js';
import { validateWorkflowSource } from './runtime/validate-workflow.js';
import type {
  AgentExecutor,
  WorkflowExecutionResult,
  WorkflowRuntimeContext,
} from './runtime/types.js';
import type { WorkflowRequest } from './workflow-invocation.js';
import { runDoctor } from './doctor.js';

export type WorkflowRunStatus = 'planned' | 'denied' | 'completed' | 'failed';

export type WorkflowServiceResult = {
  runId: string;
  runDir: string;
  status: WorkflowRunStatus;
  workflowSource: string;
  result?: unknown;
  metrics?: WorkflowExecutionResult['metrics'];
  error?: string;
};

export type WorkflowExecutionOptions = {
  approve?: ApprovalPrompt;
  onPreview?: (source: string, runId: string) => void;
};

export interface WorkflowServiceApi {
  execute(request: WorkflowRequest, options?: WorkflowExecutionOptions): Promise<WorkflowServiceResult>;
  lastRun(): Promise<unknown>;
  listRuns(): Promise<unknown>;
  doctor(): Promise<unknown>;
  buildSandbox(): Promise<unknown>;
  close(): Promise<void>;
}

export type WorkflowServiceDependencies = {
  createRegistry: (
    config: ResolvedProjectConfig,
    permissions: PermissionManager,
  ) => Promise<CapabilityRegistryApi>;
  generate: (input: {
    description: string;
    manifest: RuntimeManifest;
    runId: string;
  }) => Promise<string>;
  createExecutor: (input: {
    registry: CapabilityRegistryApi;
    runId: string;
  }) => Promise<AgentExecutor> | AgentExecutor;
  run: (
    source: string,
    input: unknown,
    context: WorkflowRuntimeContext,
  ) => Promise<WorkflowExecutionResult>;
  doctor: () => Promise<unknown>;
  buildSandbox: () => Promise<unknown>;
};

export class WorkflowService implements WorkflowServiceApi {
  constructor(
    private readonly config: ResolvedProjectConfig,
    private readonly limits: WorkflowLimits,
    private readonly dependencies: WorkflowServiceDependencies,
  ) {}

  async execute(request: WorkflowRequest, options: WorkflowExecutionOptions = {}): Promise<WorkflowServiceResult> {
    await this.ensureStateDirectories();
    const runId = createRunId();
    const runDir = path.join(this.config.runsDir, runId);
    await fs.mkdir(runDir, { recursive: false });
    await writeJson(path.join(runDir, 'request.json'), request);

    const permissionDecisions: Array<PermissionRequest & { approved: boolean; at: string }> = [];
    const permissions = new PermissionManager({
      autoApprove: request.yes,
      approve: options.approve,
      onDecision: (permission, approved) => {
        permissionDecisions.push({ ...permission, approved, at: new Date().toISOString() });
      },
    });
    let registry: CapabilityRegistryApi | undefined;
    let source = '';

    try {
      registry = await this.dependencies.createRegistry(this.config, permissions);
      const manifest: RuntimeManifest = {
        primitives: [
          { signature: 'agent(prompt, opts?)', semantics: 'Run one worker and return text or validated JSON.' },
          { signature: 'parallel(thunks)', semantics: 'Run lazy task functions concurrently and wait for all.' },
          { signature: 'pipeline(items, ...stages)', semantics: 'Stream each item through asynchronous stages.' },
          { signature: 'workflow(nameOrRef, args?)', semantics: 'Invoke an available saved workflow as a child.' },
          { signature: 'phase(title)', semantics: 'Set the current progress group.' },
          { signature: 'log(message)', semantics: 'Emit a bounded narrator line.' },
        ],
        capabilities: registry.manifest(),
        savedWorkflows: await listSavedWorkflows(this.config.workflowsDir),
        workspaceRoot: this.config.workspaceRoot,
        limits: this.limits,
        provider: {
          apiMode: 'chat-completions',
          supportsFunctionTools: true,
          supportsStructuredOutputWithTools: false,
          unsupported: ['hosted-web-search', 'hosted-shell', 'hosted-mcp', 'tool-search', 'deferLoading'],
        },
      };
      await writeJson(path.join(runDir, 'manifest.json'), manifest);

      source = await this.dependencies.generate({
        description: request.description,
        manifest,
        runId,
      });
      const validation = validateWorkflowSource(source, this.limits.maxScriptChars);
      await fs.writeFile(path.join(runDir, 'workflow.generated.js'), validation.normalizedSource, 'utf8');
      if (!validation.ok) {
        await writeJson(path.join(runDir, 'validation-errors.json'), validation.errors);
        throw new Error(`Workflow validation failed:\n${validation.errors.join('\n')}`);
      }
      source = validation.normalizedSource;
      options.onPreview?.(source, runId);

      if (request.action === 'plan') {
        const result: WorkflowServiceResult = { runId, runDir, status: 'planned', workflowSource: source };
        await writeStatus(runDir, result);
        return result;
      }

      try {
        await permissions.authorize({
          capabilityId: 'runtime.execute',
          risk: 'admin',
          action: 'execute generated workflow',
          details: `run ${runId}`,
        });
      } catch (error) {
        const result: WorkflowServiceResult = {
          runId,
          runDir,
          status: 'denied',
          workflowSource: source,
          error: error instanceof Error ? error.message : String(error),
        };
        await writeStatus(runDir, result);
        return result;
      }

      const executor = await this.dependencies.createExecutor({ registry, runId });
      const execution = await this.dependencies.run(
        source,
        { description: request.description },
        {
          executor,
          limits: this.limits,
          registry,
          permissions,
          manifest: registry.manifest(),
          workflowsDir: this.config.workflowsDir,
        },
      );
      await fs.writeFile(
        path.join(runDir, 'events.jsonl'),
        `${execution.events.map((event) => JSON.stringify(event)).join('\n')}${execution.events.length ? '\n' : ''}`,
        'utf8',
      );
      await writeJson(path.join(runDir, 'metrics.json'), execution.metrics);
      await writeJson(path.join(runDir, 'report.json'), {
        result: execution.result ?? null,
        capabilities: registry.manifest(),
      });
      const result: WorkflowServiceResult = {
        runId,
        runDir,
        status: 'completed',
        workflowSource: source,
        result: execution.result,
        metrics: execution.metrics,
      };
      await writeStatus(runDir, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: WorkflowServiceResult = {
        runId,
        runDir,
        status: 'failed',
        workflowSource: source,
        error: message,
      };
      await writeStatus(runDir, result);
      throw Object.assign(new Error(message), { runResult: result });
    } finally {
      await writeJson(path.join(runDir, 'permissions.json'), permissionDecisions);
      await registry?.close();
    }
  }

  async listRuns(): Promise<unknown> {
    await this.ensureStateDirectories();
    const entries = await fs.readdir(this.config.runsDir, { withFileTypes: true });
    const runs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 20);
    return Promise.all(
      runs.map(async (runId) => {
        const status = await readJson(path.join(this.config.runsDir, runId, 'status.json')).catch(() => undefined);
        return status ?? { runId, status: 'unknown' };
      }),
    );
  }

  async lastRun(): Promise<unknown> {
    const runs = (await this.listRuns()) as unknown[];
    return runs[0] ?? { status: 'none' };
  }

  doctor(): Promise<unknown> {
    return this.dependencies.doctor();
  }

  buildSandbox(): Promise<unknown> {
    return this.dependencies.buildSandbox();
  }

  async close(): Promise<void> {
    // Registries are closed after every run, including failed planner runs.
  }

  private async ensureStateDirectories(): Promise<void> {
    await fs.mkdir(this.config.runsDir, { recursive: true });
    await fs.mkdir(this.config.workflowsDir, { recursive: true });
  }
}

export async function createDefaultWorkflowService(projectRoot = process.cwd()): Promise<WorkflowService> {
  const config = await loadProjectConfig(projectRoot);
  const dependencies: WorkflowServiceDependencies = {
    createRegistry: buildCapabilityRegistry,
    generate: async ({ description, manifest, runId }) => {
      const modelConfig = loadModelConfig();
      return generateWorkflow({
        runner: createRunner(modelConfig, `dynamic-workflow-planner-${runId}`),
        model: modelConfig.modelName,
        description,
        manifest,
      });
    },
    createExecutor: ({ registry, runId }) => {
      const modelConfig = loadModelConfig();
      return createWorkflowAgentExecutor({
        runner: createRunner(modelConfig, `dynamic-workflow-workers-${runId}`),
        model: modelConfig.modelName,
        registry,
      });
    },
    run: runWorkflowInDocker,
    doctor: async () => {
      const modelConfig = loadModelConfig();
      return runDoctor(createRunner(modelConfig, 'dynamic-workflow-doctor'), modelConfig.modelName);
    },
    buildSandbox: () => buildSandbox(config.projectRoot),
  };
  return new WorkflowService(config, defaultLimits, dependencies);
}

async function listSavedWorkflows(workflowsDir: string): Promise<string[]> {
  const names: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.workflow.js')) {
        names.push(path.relative(workflowsDir, absolute).replaceAll(path.sep, '/').replace(/\.workflow\.js$/, ''));
      }
    }
  }
  await visit(workflowsDir);
  return names.sort();
}

async function buildSandbox(projectRoot: string): Promise<{ ok: true; image: string }> {
  const image = 'dynamic-workflow-sandbox:local';
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['build', '-t', image, path.join(projectRoot, 'sandbox')], {
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build exited with code ${code}`));
    });
  });
  return { ok: true, image };
}

async function writeStatus(runDir: string, result: WorkflowServiceResult): Promise<void> {
  await writeJson(path.join(runDir, 'status.json'), {
    runId: result.runId,
    status: result.status,
    runDir: result.runDir,
    error: result.error,
    metrics: result.metrics,
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${timestamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}
