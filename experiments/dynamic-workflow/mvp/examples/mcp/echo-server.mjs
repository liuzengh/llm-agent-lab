import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'dynamic-workflow-echo',
  version: '1.0.0',
});

server.registerTool(
  'echo',
  {
    description: 'Echo text for dynamic workflow MCP smoke tests.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }),
);

server.registerTool(
  'not_allowlisted',
  {
    description: 'A tool that should be filtered out by the example config.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'this tool should not be visible' }],
  }),
);

await server.connect(new StdioServerTransport());
