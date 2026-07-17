import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tool } from '@openai/agents';
import { PermissionManager } from '../src/permissions.js';
import {
  createShellTools,
  createWorkspaceWriteTools,
  fetchAllowedUrl,
} from '../src/tools/general.js';

describe('general capability tools', () => {
  it('contains writes and rejects path escapes and symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-write-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-outside-'));
    await fs.symlink(outside, path.join(root, 'linked'));
    const permissions = new PermissionManager({ autoApprove: true });
    const tools = createWorkspaceWriteTools({ workspaceRoot: root, permissions });

    await expect(call(tools, 'write_file', { path: '../escape.txt', content: 'bad' })).resolves.toMatch(
      /escapes workspace/i,
    );
    await expect(call(tools, 'write_file', { path: 'linked/escape.txt', content: 'bad' })).resolves.toMatch(
      /unsafe parent|symbolic/i,
    );
    await expect(call(tools, 'write_file', { path: 'safe/result.txt', content: 'ok' })).resolves.toBeDefined();
    await expect(fs.readFile(path.join(root, 'safe/result.txt'), 'utf8')).resolves.toBe('ok');
  });

  it('executes only exact allowlisted commands without a shell', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-shell-'));
    const permissions = new PermissionManager({ autoApprove: true });
    const tools = createShellTools(
      { workspaceRoot: root, permissions },
      { allowedCommands: [process.execPath], timeoutMs: 5_000 },
    );

    await expect(call(tools, 'exec_command', { command: 'sh', args: ['-c', 'echo unsafe'] })).resolves.toMatch(
      /not allowlisted/i,
    );
    const output = await call(tools, 'exec_command', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("tool-ok")'],
    });
    expect(JSON.stringify(output)).toContain('tool-ok');
  });

  it('checks web domains again after redirects and enforces response size', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        response.writeHead(302, { location: `http://localhost:${port}/ok` }).end();
      } else if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(200));
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('web-ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const fetchOptions = {
      allowedDomains: ['127.0.0.1'],
      maxResponseBytes: 100,
      timeoutMs: 5_000,
    };

    try {
      await expect(fetchAllowedUrl(`http://127.0.0.1:${port}/ok`, fetchOptions)).resolves.toMatchObject({
        body: 'web-ok',
      });
      await expect(fetchAllowedUrl(`http://127.0.0.1:${port}/redirect`, fetchOptions)).rejects.toThrow(
        /not allowlisted/i,
      );
      await expect(fetchAllowedUrl(`http://127.0.0.1:${port}/large`, fetchOptions)).rejects.toThrow(
        /exceeds 100 bytes/i,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('serializes concurrent TTY approval prompts', async () => {
    let active = 0;
    let maxActive = 0;
    const decisions: string[] = [];
    const permissions = new PermissionManager({
      autoApprove: false,
      approve: async (request) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        decisions.push(request.action);
        active--;
        return true;
      },
    });

    await Promise.all([
      permissions.authorize({ capabilityId: 'a', risk: 'write', action: 'first', details: '1' }),
      permissions.authorize({ capabilityId: 'b', risk: 'exec', action: 'second', details: '2' }),
    ]);
    expect(maxActive).toBe(1);
    expect(decisions).toEqual(['first', 'second']);
  });
});

async function call(tools: Tool[], name: string, input: unknown): Promise<string | unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  if (!selected || selected.type !== 'function') throw new Error(`Missing function tool: ${name}`);
  return selected.invoke({} as never, JSON.stringify(input));
}
