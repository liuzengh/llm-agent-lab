import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  createMCPToolStaticFilter,
  mcpToFunctionTool,
  type MCPServer,
  type Tool,
} from '@openai/agents';
import type { ResolvedProjectConfig, McpServerConfig } from '../config.js';
import type { PermissionManager } from '../permissions.js';
import { createRepositoryTools } from '../tools/repository.js';
import {
  createHttpWebSearchAdapter,
  createShellTools,
  createWebFetchTools,
  createWebSearchTool,
  createWorkspaceWriteTools,
  type WebSearchAdapter,
} from '../tools/general.js';
import type {
  CapabilityDefinition,
  CapabilityRegistryApi,
  CapabilitySelection,
  RuntimeCapabilityManifest,
} from './types.js';

export type CapabilityRegistryOptions = {
  webSearchAdapter?: WebSearchAdapter;
};

export class CapabilityRegistry implements CapabilityRegistryApi {
  constructor(
    private readonly definitions: Map<string, CapabilityDefinition>,
    private readonly failed: Array<{ id: string; error: string }>,
    private readonly servers: MCPServer[],
  ) {}

  manifest(): RuntimeCapabilityManifest {
    return {
      capabilities: [...this.definitions.values()].map((definition) => definition.manifest),
      failedCapabilities: [...this.failed],
    };
  }

  select(ids?: string[]): CapabilitySelection {
    const requested = ids === undefined ? (this.definitions.has('workspace.read') ? ['workspace.read'] : []) : ids;
    const uniqueIds = [...new Set(requested)];
    const tools: Tool[] = [];
    const toolNames = new Set<string>();

    for (const id of uniqueIds) {
      const definition = this.definitions.get(id);
      if (!definition) throw new Error(`Unknown or unavailable capability: ${id}`);
      for (const selectedTool of definition.tools) {
        const name = selectedTool.name;
        if (toolNames.has(name)) throw new Error(`Tool name collision while selecting capabilities: ${name}`);
        toolNames.add(name);
        tools.push(selectedTool);
      }
    }
    return { ids: uniqueIds, tools };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.servers].reverse().map((server) => server.close()));
  }
}

export async function buildCapabilityRegistry(
  config: ResolvedProjectConfig,
  permissions: PermissionManager,
  options: CapabilityRegistryOptions = {},
): Promise<CapabilityRegistry> {
  const definitions = new Map<string, CapabilityDefinition>();
  const failed: Array<{ id: string; error: string }> = [];
  const servers: MCPServer[] = [];
  const context = { workspaceRoot: config.workspaceRoot, permissions };

  addDefinition(definitions, {
    id: 'workspace.read',
    description: 'List, read, and search text files inside the configured workspace root.',
    risk: 'read',
    tools: await createRepositoryTools({ root: config.workspaceRoot }),
  });

  if (config.enableWorkspaceWrite) {
    addDefinition(definitions, {
      id: 'workspace.write',
      description: 'Create files and perform exact text replacements inside the workspace root.',
      risk: 'write',
      tools: createWorkspaceWriteTools(context),
    });
  }

  if (config.shellCommands.length > 0) {
    addDefinition(definitions, {
      id: 'shell.exec',
      description: `Execute local commands without a shell. Allowlist: ${config.shellCommands.join(', ')}.`,
      risk: 'exec',
      tools: createShellTools(context, { allowedCommands: config.shellCommands }),
    });
  }

  if (config.webDomains.length > 0) {
    addDefinition(definitions, {
      id: 'web.fetch',
      description: `Fetch text and JSON over HTTP GET. Domain allowlist: ${config.webDomains.join(', ')}.`,
      risk: 'network',
      tools: createWebFetchTools(context, { allowedDomains: config.webDomains }),
    });
  }

  const webSearchAdapter =
    options.webSearchAdapter ??
    (config.webSearch
      ? createHttpWebSearchAdapter({
          url: config.webSearch.url,
          apiKey: config.webSearch.apiKey,
        })
      : undefined);
  if (webSearchAdapter) {
    addDefinition(definitions, {
      id: 'web.search',
      description: 'Search the web through the configured server-side search adapter.',
      risk: 'network',
      tools: [createWebSearchTool(context, webSearchAdapter)],
    });
  }

  for (const serverConfig of config.mcpServers) {
    const capabilityId = `mcp.${serverConfig.id}`;
    try {
      validateMcpConfig(serverConfig);
      await permissions.authorize({
        capabilityId,
        risk: serverConfig.transport === 'stdio' ? 'exec' : 'network',
        action: 'connect MCP server',
        details:
          serverConfig.transport === 'stdio'
            ? `${serverConfig.command} ${(serverConfig.args ?? []).join(' ')}`.trim()
            : serverConfig.url!,
      });
      const server = createMcpServer(serverConfig, config.projectRoot);
      await server.connect();
      servers.push(server);
      const listedTools = await server.listTools();
      const allowedTools = serverConfig.allowedTools ? new Set(serverConfig.allowedTools) : undefined;
      const converted = listedTools
        .filter((listedTool) => !allowedTools || allowedTools.has(listedTool.name))
        .map((listedTool) =>
          mcpToFunctionTool(listedTool, server, false, {
            toolNameOverride: `mcp_${sanitizeId(serverConfig.id)}_${sanitizeId(listedTool.name)}`,
          }),
        );
      const risk = serverConfig.risk ?? (serverConfig.transport === 'http' ? 'network' : 'admin');
      const wrapped = converted.map((mcpTool) => wrapMcpTool(mcpTool, capabilityId, risk, permissions));
      addDefinition(definitions, {
        id: capabilityId,
        description: `Tools exposed by the configured ${serverConfig.transport} MCP server "${serverConfig.id}".`,
        risk,
        tools: wrapped,
        source: 'mcp',
      });
    } catch (error) {
      failed.push({
        id: capabilityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return new CapabilityRegistry(definitions, failed, servers);
}

function addDefinition(
  definitions: Map<string, CapabilityDefinition>,
  input: {
    id: string;
    description: string;
    risk: CapabilityDefinition['manifest']['risk'];
    tools: Tool[];
    source?: 'builtin' | 'mcp';
  },
): void {
  if (definitions.has(input.id)) throw new Error(`Duplicate capability ID: ${input.id}`);
  for (const selectedTool of input.tools) {
    if ('deferLoading' in selectedTool && selectedTool.deferLoading) {
      throw new Error(`Capability ${input.id} uses Responses-only deferLoading.`);
    }
    if (selectedTool.type !== 'function') {
      throw new Error(`Capability ${input.id} contains unsupported Chat Completions tool type: ${selectedTool.type}`);
    }
  }
  definitions.set(input.id, {
    manifest: {
      id: input.id,
      description: input.description,
      risk: input.risk,
      providerCompatibility: ['chat-completions'],
      tools: input.tools.map((selectedTool) => selectedTool.name),
      source: input.source ?? 'builtin',
    },
    tools: input.tools,
  });
}

function createMcpServer(config: McpServerConfig, projectRoot: string): MCPServer {
  const toolFilter = config.allowedTools
    ? createMCPToolStaticFilter({
        allowed: config.allowedTools,
      })
    : undefined;
  if (config.transport === 'stdio') {
    return new MCPServerStdio({
      name: `mcp_${sanitizeId(config.id)}`,
      command: config.command!,
      args: config.args ?? [],
      cwd: projectRoot,
      toolFilter,
    });
  }
  return new MCPServerStreamableHttp({
    name: `mcp_${sanitizeId(config.id)}`,
    url: config.url!,
    toolFilter,
  });
}

function validateMcpConfig(config: McpServerConfig): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(config.id)) throw new Error(`Invalid MCP server ID: ${config.id}`);
  if (config.transport === 'stdio' && !config.command) throw new Error(`MCP server ${config.id} requires command.`);
  if (config.transport === 'http') {
    if (!config.url) throw new Error(`MCP server ${config.id} requires url.`);
    const url = new URL(config.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`MCP server ${config.id} must use HTTP(S).`);
    }
  }
}

function wrapMcpTool(
  mcpTool: Tool,
  capabilityId: string,
  risk: CapabilityDefinition['manifest']['risk'],
  permissions: PermissionManager,
): Tool {
  if (mcpTool.type !== 'function') throw new Error(`Unsupported MCP tool type: ${mcpTool.type}`);
  const invoke = mcpTool.invoke.bind(mcpTool);
  return {
    ...mcpTool,
    invoke: async (runContext, input, details) => {
      await permissions.authorize({
        capabilityId,
        risk,
        action: mcpTool.name,
        details: input,
      });
      return invoke(runContext, input, details);
    },
    needsApproval: async () => false,
  };
}

function sanitizeId(id: string): string {
  return id.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}
