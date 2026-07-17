import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  modelName: string;
};

export type McpServerConfig = {
  id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  allowedTools?: string[];
  risk?: 'read' | 'network' | 'write' | 'exec' | 'admin';
};

export type WorkflowProjectConfig = {
  workspaceRoot?: string;
  enableWorkspaceWrite?: boolean;
  shellCommands?: string[];
  webDomains?: string[];
  webSearch?: {
    url: string;
    apiKeyEnv?: string;
  };
  mcpServers?: McpServerConfig[];
};

export type ResolvedProjectConfig = {
  projectRoot: string;
  stateDir: string;
  runsDir: string;
  workflowsDir: string;
  workspaceRoot: string;
  enableWorkspaceWrite: boolean;
  shellCommands: string[];
  webDomains: string[];
  webSearch?: {
    url: string;
    apiKey?: string;
  };
  mcpServers: McpServerConfig[];
};

export type WorkflowLimits = {
  maxAgents: number;
  maxConcurrency: number;
  maxWorkflowCalls: number;
  maxWorkflowDepth: number;
  maxLogChars: number;
  agentTimeoutMs: number;
  maxAgentInputChars: number;
  maxAgentOutputChars: number;
  maxScriptChars: number;
};

export const defaultLimits: WorkflowLimits = {
  maxAgents: numberFromEnv('WORKFLOW_MAX_AGENTS', 32),
  maxConcurrency: numberFromEnv('WORKFLOW_MAX_CONCURRENCY', 4),
  maxWorkflowCalls: numberFromEnv('WORKFLOW_MAX_WORKFLOWS', 32),
  maxWorkflowDepth: 1,
  maxLogChars: 2_000,
  agentTimeoutMs: numberFromEnv('WORKFLOW_AGENT_TIMEOUT_MS', 90_000),
  maxAgentInputChars: 24_000,
  maxAgentOutputChars: 24_000,
  maxScriptChars: 32_000,
};

export function loadModelConfig(): ModelConfig {
  const baseURL = requiredEnv('OPENAI_BASE_URL');
  const apiKey = requiredEnv('OPENAI_API_KEY');
  const modelName = requiredEnv('MODEL_NAME');
  return { baseURL, apiKey, modelName };
}

export function resolvePathFromCwd(input: string): string {
  return path.resolve(process.cwd(), input);
}

export async function loadProjectConfig(projectRoot = process.cwd()): Promise<ResolvedProjectConfig> {
  const root = path.resolve(projectRoot);
  const stateDir = path.join(root, '.workflow');
  const configPath = path.join(stateDir, 'config.json');
  let raw: WorkflowProjectConfig = {};
  try {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as WorkflowProjectConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const workspaceRoot = path.resolve(root, raw.workspaceRoot ?? '.');
  return {
    projectRoot: root,
    stateDir,
    runsDir: path.join(stateDir, 'runs'),
    workflowsDir: path.join(stateDir, 'workflows'),
    workspaceRoot,
    enableWorkspaceWrite: raw.enableWorkspaceWrite ?? false,
    shellCommands: uniqueStrings(raw.shellCommands),
    webDomains: uniqueStrings(raw.webDomains).map((domain) => domain.toLowerCase()),
    webSearch: raw.webSearch
      ? {
          url: raw.webSearch.url,
          apiKey: raw.webSearch.apiKeyEnv ? process.env[raw.webSearch.apiKeyEnv] : undefined,
        }
      : process.env.WORKFLOW_WEB_SEARCH_URL
        ? {
            url: process.env.WORKFLOW_WEB_SEARCH_URL,
            apiKey: process.env.WORKFLOW_WEB_SEARCH_API_KEY,
          }
        : undefined,
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env or export it in your shell.`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}
