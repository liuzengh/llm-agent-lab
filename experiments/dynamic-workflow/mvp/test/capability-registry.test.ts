import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedProjectConfig } from '../src/config.js';
import { buildCapabilityRegistry } from '../src/capabilities/registry.js';
import { PermissionManager } from '../src/permissions.js';

describe('capability registry', () => {
  it('exposes only configured Chat Completions function tools', async () => {
    const config = await temporaryConfig({
      enableWorkspaceWrite: true,
      shellCommands: ['node'],
      webDomains: ['example.com'],
    });
    const registry = await buildCapabilityRegistry(
      config,
      new PermissionManager({ autoApprove: true }),
      { webSearchAdapter: async (query) => ({ query }) },
    );
    try {
      const manifest = registry.manifest();
      expect(manifest.capabilities.map((capability) => capability.id)).toEqual([
        'workspace.read',
        'workspace.write',
        'shell.exec',
        'web.fetch',
        'web.search',
      ]);
      expect(manifest.capabilities.every((capability) =>
        capability.providerCompatibility.includes('chat-completions'))).toBe(true);
      expect(registry.select().ids).toEqual(['workspace.read']);
      expect(registry.select(['shell.exec']).tools).toHaveLength(1);
      expect(() => registry.select(['hosted.shell'])).toThrow(/unknown or unavailable/i);
    } finally {
      await registry.close();
    }
  });

  it('degrades an unapproved MCP server and omits it from the manifest', async () => {
    const config = await temporaryConfig({
      mcpServers: [
        {
          id: 'denied',
          transport: 'stdio',
          command: process.execPath,
          args: ['does-not-run.mjs'],
          risk: 'read',
        },
      ],
    });
    const registry = await buildCapabilityRegistry(config, new PermissionManager({ autoApprove: false }));
    try {
      expect(registry.manifest().capabilities.some((item) => item.id === 'mcp.denied')).toBe(false);
      expect(registry.manifest().failedCapabilities).toEqual([
        expect.objectContaining({ id: 'mcp.denied', error: expect.stringMatching(/permission denied/i) }),
      ]);
    } finally {
      await registry.close();
    }
  });

  it('connects, filters, calls, and closes a stdio MCP server', async () => {
    const echoServer = path.resolve(process.cwd(), 'examples/mcp/echo-server.mjs');
    const config = await temporaryConfig({
      projectRoot: process.cwd(),
      mcpServers: [
        {
          id: 'echo',
          transport: 'stdio',
          command: process.execPath,
          args: [echoServer],
          allowedTools: ['echo'],
          risk: 'read',
        },
      ],
    });
    const registry = await buildCapabilityRegistry(config, new PermissionManager({ autoApprove: true }));
    try {
      const capability = registry.manifest().capabilities.find((item) => item.id === 'mcp.echo');
      expect(capability).toBeDefined();
      expect(capability?.tools).toHaveLength(1);
      expect(capability?.tools.join(' ')).not.toContain('not_allowlisted');

      const selected = registry.select(['mcp.echo']);
      const echo = selected.tools[0];
      if (echo.type !== 'function') throw new Error('Expected function tool.');
      const output = await echo.invoke({} as never, JSON.stringify({ text: 'smoke' }));
      expect(JSON.stringify(output)).toContain('echo:smoke');
    } finally {
      await registry.close();
    }
  }, 15_000);
});

async function temporaryConfig(
  overrides: Partial<ResolvedProjectConfig> = {},
): Promise<ResolvedProjectConfig> {
  const projectRoot = overrides.projectRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-registry-'));
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
    ...overrides,
  };
}
