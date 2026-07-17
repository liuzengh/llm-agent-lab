import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultLimits, type ResolvedProjectConfig } from '../src/config.js';
import type { CapabilityRegistryApi } from '../src/capabilities/types.js';
import { WorkflowService, type WorkflowServiceDependencies } from '../src/workflow-service.js';

const workflowSource = `
export const meta = { name: 'test', description: 'test workflow' }
phase('test')
return { ok: true }
`;

describe('workflow service', () => {
  it('supports plan-only without constructing an executor or runtime', async () => {
    const config = await temporaryConfig();
    const run = vi.fn();
    const createExecutor = vi.fn();
    let generatedManifest: unknown;
    const service = new WorkflowService(
      config,
      defaultLimits,
      dependencies({
        generate: async ({ manifest }) => {
          generatedManifest = manifest;
          return workflowSource;
        },
        createExecutor,
        run,
      }),
    );

    const result = await service.execute({ action: 'plan', description: 'inspect tests', yes: false });

    expect(result.status).toBe('planned');
    expect(createExecutor).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(generatedManifest).toEqual(
      expect.objectContaining({
        savedWorkflows: [],
        provider: expect.objectContaining({ apiMode: 'chat-completions' }),
        capabilities: expect.objectContaining({
          capabilities: [expect.objectContaining({ id: 'workspace.read' })],
        }),
      }),
    );
    await expect(fs.readFile(path.join(result.runDir, 'workflow.generated.js'), 'utf8')).resolves.toContain(
      "name: 'test'",
    );
    await expect(fs.readFile(path.join(result.runDir, 'manifest.json'), 'utf8')).resolves.toContain(
      'workspace.read',
    );
  });

  it('records preview approval rejection without running', async () => {
    const config = await temporaryConfig();
    const run = vi.fn();
    const service = new WorkflowService(config, defaultLimits, dependencies({ run }));

    const result = await service.execute(
      { action: 'run', description: 'do work', yes: false },
      { approve: async () => false },
    );

    expect(result.status).toBe('denied');
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(result.runDir, 'status.json'), 'utf8'))).toMatchObject({
      status: 'denied',
    });
  });

  it('writes reports and events under .workflow/runs', async () => {
    const config = await temporaryConfig();
    const service = new WorkflowService(config, defaultLimits, dependencies());

    const result = await service.execute({ action: 'run', description: 'do work', yes: true });

    expect(result.status).toBe('completed');
    expect(result.runDir.startsWith(config.runsDir)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(result.runDir, 'report.json'), 'utf8'))).toMatchObject({
      result: { ok: true },
      capabilities: { capabilities: [expect.objectContaining({ id: 'workspace.read' })] },
    });
    expect(JSON.parse(await fs.readFile(path.join(result.runDir, 'permissions.json'), 'utf8'))).toEqual([
      expect.objectContaining({ capabilityId: 'runtime.execute', approved: true }),
    ]);
    await expect(service.lastRun()).resolves.toEqual(expect.objectContaining({ runId: result.runId }));
  });

  it('closes a registry when generation fails', async () => {
    const config = await temporaryConfig();
    const close = vi.fn(async () => undefined);
    const service = new WorkflowService(
      config,
      defaultLimits,
      dependencies({
        createRegistry: async () => fakeRegistry(close),
        generate: async () => {
          throw new Error('planner failed');
        },
      }),
    );

    await expect(
      service.execute({ action: 'plan', description: 'fail', yes: false }),
    ).rejects.toThrow('planner failed');
    expect(close).toHaveBeenCalledOnce();
    const runs = (await service.listRuns()) as Array<{ status: string }>;
    expect(runs[0]).toMatchObject({ status: 'failed' });
  });
});

function dependencies(
  overrides: Partial<WorkflowServiceDependencies> = {},
): WorkflowServiceDependencies {
  return {
    createRegistry: async () => fakeRegistry(),
    generate: async () => workflowSource,
    createExecutor: async () => async () => 'worker result',
    run: async (_source, _input, context) => ({
      result: { ok: true },
      events: [
        {
          type: 'capabilities',
          active: context.manifest.capabilities.map((capability) => capability.id),
          failed: [],
          at: new Date().toISOString(),
        },
      ],
      metrics: {
        agentCalls: 0,
        workflowCalls: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 1,
      },
    }),
    doctor: async () => [{ name: 'fake', ok: true }],
    buildSandbox: async () => ({ ok: true }),
    ...overrides,
  };
}

function fakeRegistry(close = async () => undefined): CapabilityRegistryApi {
  return {
    manifest: () => ({
      capabilities: [
        {
          id: 'workspace.read',
          description: 'read',
          risk: 'read',
          providerCompatibility: ['chat-completions'],
          tools: [],
          source: 'builtin',
        },
      ],
      failedCapabilities: [],
    }),
    select: () => ({ ids: ['workspace.read'], tools: [] }),
    close,
  };
}

async function temporaryConfig(): Promise<ResolvedProjectConfig> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-service-'));
  const stateDir = path.join(projectRoot, '.workflow');
  return {
    projectRoot,
    stateDir,
    runsDir: path.join(stateDir, 'runs'),
    workflowsDir: path.join(stateDir, 'workflows'),
    workspaceRoot: projectRoot,
    enableWorkspaceWrite: false,
    shellCommands: [],
    webDomains: [],
    mcpServers: [],
  };
}
