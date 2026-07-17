import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../src/config.js';
import {
  runSandboxProcess,
  runWorkflowInDocker,
} from '../src/runtime/host.js';
import { PermissionManager } from '../src/permissions.js';
import type { AgentExecutor, SandboxLauncher, WorkflowRuntimeContext } from '../src/runtime/types.js';

const runnerPath = path.resolve(process.cwd(), 'sandbox', 'runner.mjs');
const localLauncher: SandboxLauncher = ({ workflowPath, argsPath }) => ({
  command: process.execPath,
  args: [runnerPath, workflowPath, ...(argsPath ? [argsPath] : [])],
});

describe('sandbox host RPC', () => {
  it('runs a workflow with mock agent responses', async () => {
    const workflowPath = await writeWorkflow(`
const files = await agent('find files')
const audits = await pipeline(files, file => agent('audit ' + file, { label: file }))
return { files, audits }
`);

    const result = await runSandboxProcess({
      command: process.execPath,
      args: [runnerPath, workflowPath],
      limits: { ...defaultLimits, maxAgents: 4, maxConcurrency: 2 },
      timeoutMs: 10_000,
      executor: async (request) => {
        if (request.prompt === 'find files') return ['a.ts', 'b.ts'];
        return { label: request.options?.label, ok: true };
      },
    });

    expect(result.metrics.agentCalls).toBe(3);
    expect(result.result).toEqual({
      files: ['a.ts', 'b.ts'],
      audits: [
        { label: 'a.ts', ok: true },
        { label: 'b.ts', ok: true },
      ],
    });
  });

  it('fails closed when the agent budget is exceeded', async () => {
    const workflowPath = await writeWorkflow(`
await agent('first')
await agent('second')
return 'done'
`);

    await expect(
      runSandboxProcess({
        command: process.execPath,
        args: [runnerPath, workflowPath],
        limits: { ...defaultLimits, maxAgents: 1, maxConcurrency: 1 },
        timeoutMs: 10_000,
        executor: async () => 'ok',
      }),
    ).rejects.toThrow(/budget exceeded/i);
  });

  it('runs parallel thunks behind a barrier and records phase/log events', async () => {
    const workflowPath = await writeWorkflow(`
phase('Review')
log('starting branches')
const results = await parallel([
  () => agent('slow'),
  () => agent('fast'),
])
log('joined branches')
return results
`);
    const timeline: string[] = [];

    const result = await runSandboxProcess({
      command: process.execPath,
      args: [runnerPath, workflowPath],
      limits: { ...defaultLimits, maxConcurrency: 2 },
      timeoutMs: 10_000,
      executor: async ({ prompt }) => {
        timeline.push(`start:${prompt}`);
        await delay(prompt === 'slow' ? 40 : 5);
        timeline.push(`end:${prompt}`);
        return prompt;
      },
    });

    expect(result.result).toEqual(['slow', 'fast']);
    expect(timeline.indexOf('start:fast')).toBeLessThan(timeline.indexOf('end:slow'));
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'phase', title: 'Review' }));
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'workflow-log', message: 'joined branches', phase: 'Review' }),
    );
  });

  it('streams each pipeline item to its next stage without a stage-wide barrier', async () => {
    const workflowPath = await writeWorkflow(`
return await pipeline(
  ['a', 'b'],
  item => agent('stage1:' + item),
  item => agent('stage2:' + item),
)
`);
    const timeline: string[] = [];

    const result = await runSandboxProcess({
      command: process.execPath,
      args: [runnerPath, workflowPath],
      limits: { ...defaultLimits, maxConcurrency: 2 },
      timeoutMs: 10_000,
      executor: async ({ prompt }) => {
        timeline.push(`start:${prompt}`);
        if (prompt === 'stage1:b') await delay(50);
        else await delay(5);
        timeline.push(`end:${prompt}`);
        return prompt.split(':')[1];
      },
    });

    expect(result.result).toEqual(['a', 'b']);
    expect(timeline.indexOf('start:stage2:a')).toBeLessThan(timeline.indexOf('end:stage1:b'));
  });

  it('invokes one saved workflow with args and shares the agent budget', async () => {
    const workflowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-workflows-'));
    await fs.writeFile(
      path.join(workflowDir, 'child.workflow.js'),
      `
phase('Child')
log('received ' + args.value)
const child = await agent('child:' + args.value)
return { input: args.value, child }
`,
    );

    const result = await runWorkflowInDocker(
      `
const parent = await agent('parent')
const child = await workflow('child', { value: parent })
return child
`,
      { root: true },
      runtimeContext(workflowDir, async ({ prompt }) => prompt, {
        limits: { ...defaultLimits, maxAgents: 2, maxWorkflowDepth: 1 },
      }),
    );

    expect(result.result).toEqual({ input: 'parent', child: 'child:parent' });
    expect(result.metrics).toMatchObject({ agentCalls: 2, workflowCalls: 1 });
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'workflow-start', name: 'child', depth: 1 }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'workflow-end', name: 'child', depth: 1 }),
    );
  });

  it('rejects second-level nesting and saved workflow path escapes', async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-registry-parent-'));
    const workflowDir = path.join(parentDir, 'registry');
    await fs.mkdir(workflowDir);
    await fs.writeFile(
      path.join(workflowDir, 'child.workflow.js'),
      `return await workflow('grandchild', args)`,
    );
    await fs.writeFile(
      path.join(workflowDir, 'grandchild.workflow.js'),
      `return 'should-not-run'`,
    );
    await fs.writeFile(
      path.join(parentDir, 'outside.workflow.js'),
      `return 'outside'`,
    );

    const base = {
      limits: { ...defaultLimits, maxWorkflowDepth: 1 },
    };

    await expect(
      runWorkflowInDocker(
        `return await workflow('child', { value: 1 })`,
        undefined,
        runtimeContext(workflowDir, async () => 'unused', base),
      ),
    ).rejects.toThrow(/nesting depth exceeded/i);

    await expect(
      runWorkflowInDocker(
        `return await workflow('../outside')`,
        undefined,
        runtimeContext(workflowDir, async () => 'unused', base),
      ),
    ).rejects.toThrow(/escapes the workflow directory/i);
  });

  it('enforces saved workflow and shared agent budgets', async () => {
    const workflowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'budget-workflows-'));
    await fs.writeFile(
      path.join(workflowDir, 'child.workflow.js'),
      `return await agent('child')`,
    );
    const source = `return await workflow('child')`;

    await expect(
      runWorkflowInDocker(
        source,
        undefined,
        runtimeContext(workflowDir, async () => 'ok', {
          limits: { ...defaultLimits, maxAgents: 0 },
        }),
      ),
    ).rejects.toThrow(/agent budget exceeded/i);

    await expect(
      runWorkflowInDocker(
        source,
        undefined,
        runtimeContext(workflowDir, async () => 'ok', {
          limits: { ...defaultLimits, maxWorkflowCalls: 0 },
        }),
      ),
    ).rejects.toThrow(/saved workflow budget exceeded/i);
  });
});

async function writeWorkflow(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-host-'));
  const workflowPath = path.join(dir, 'workflow.js');
  await fs.writeFile(workflowPath, source, 'utf8');
  return workflowPath;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeContext(
  workflowsDir: string,
  executor: AgentExecutor,
  overrides: Partial<WorkflowRuntimeContext> = {},
): WorkflowRuntimeContext {
  const registry = {
    manifest: () => ({ capabilities: [], failedCapabilities: [] }),
    select: () => ({ ids: [], tools: [] }),
    close: async () => undefined,
  };
  return {
    executor,
    limits: defaultLimits,
    registry,
    permissions: new PermissionManager({ autoApprove: true }),
    manifest: registry.manifest(),
    workflowsDir,
    timeoutMs: 10_000,
    launcher: localLauncher,
    ...overrides,
  };
}
