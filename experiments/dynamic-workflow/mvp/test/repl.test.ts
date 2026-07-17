import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runWorkflowRepl } from '../src/repl.js';
import type { WorkflowServiceApi } from '../src/workflow-service.js';

describe('workflow REPL', () => {
  it('routes slash tasks and local monitoring commands', async () => {
    const execute = vi.fn(async (request) => ({
      runId: 'run-1',
      runDir: '/tmp/run-1',
      status: request.action === 'plan' ? 'planned' as const : 'completed' as const,
      workflowSource: 'return true',
    }));
    const service: WorkflowServiceApi = {
      execute,
      lastRun: async () => ({ runId: 'run-1', status: 'planned' }),
      listRuns: async () => [{ runId: 'run-1' }],
      doctor: async () => [{ name: 'text', ok: true }],
      buildSandbox: async () => ({ ok: true }),
      close: async () => undefined,
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => {
      text += chunk.toString();
    });

    const running = runWorkflowRepl(service, { input, output, terminal: false });
    input.write('/plan "inspect tests"\n');
    await tick();
    input.write('/last\n');
    await tick();
    input.write('/runs\n');
    await tick();
    input.write('/exit\n');
    input.end();
    await running;

    expect(execute).toHaveBeenCalledWith(
      { action: 'plan', description: 'inspect tests', yes: false },
      expect.objectContaining({ approve: expect.any(Function), onPreview: expect.any(Function) }),
    );
    expect(text).toContain('Dynamic Workflow REPL');
    expect(text).toContain('"runId": "run-1"');
    expect(text).toContain('"status": "planned"');
  });

  it('rejects non-slash task text without invoking the service', async () => {
    const execute = vi.fn();
    const service: WorkflowServiceApi = {
      execute,
      lastRun: async () => undefined,
      listRuns: async () => [],
      doctor: async () => [],
      buildSandbox: async () => undefined,
      close: async () => undefined,
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => {
      text += chunk.toString();
    });

    const running = runWorkflowRepl(service, { input, output, terminal: false });
    input.write('inspect this repo\n');
    await tick();
    input.write('/exit\n');
    input.end();
    await running;

    expect(execute).not.toHaveBeenCalled();
    expect(text).toContain('must start with /workflow or /plan');
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
