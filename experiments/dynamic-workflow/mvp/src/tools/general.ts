import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { PermissionManager } from '../permissions.js';

export type ToolFactoryContext = {
  workspaceRoot: string;
  permissions: PermissionManager;
};

export function createWorkspaceWriteTools(
  context: ToolFactoryContext,
  options: { maxFileBytes?: number } = {},
): Tool[] {
  const maxFileBytes = options.maxFileBytes ?? 250_000;

  const writeFile = tool({
    name: 'write_file',
    description: 'Write UTF-8 content to a workspace-relative file. Parent directories are created safely.',
    parameters: z.object({
      path: z.string().min(1),
      content: z.string().max(maxFileBytes),
      overwrite: z.boolean().optional(),
    }),
    execute: async ({ path: relativePath, content, overwrite = false }) => {
      if (Buffer.byteLength(content) > maxFileBytes) throw new Error(`Content exceeds ${maxFileBytes} bytes.`);
      await context.permissions.authorize({
        capabilityId: 'workspace.write',
        risk: 'write',
        action: 'write_file',
        details: relativePath,
      });
      const target = await prepareWritePath(context.workspaceRoot, relativePath);
      if (!overwrite && (await exists(target))) throw new Error(`File already exists: ${relativePath}`);
      await fs.writeFile(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
      return { path: relativePath, bytesWritten: Buffer.byteLength(content) };
    },
  });

  const replaceText = tool({
    name: 'replace_text',
    description: 'Replace one exact text occurrence in an existing workspace file.',
    parameters: z.object({
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    execute: async ({ path: relativePath, oldText, newText }) => {
      await context.permissions.authorize({
        capabilityId: 'workspace.write',
        risk: 'write',
        action: 'replace_text',
        details: relativePath,
      });
      const target = await resolveExistingNonSymlink(context.workspaceRoot, relativePath, 'file');
      const content = await fs.readFile(target, 'utf8');
      const first = content.indexOf(oldText);
      if (first < 0) throw new Error('oldText was not found.');
      if (content.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error('oldText must identify exactly one occurrence.');
      }
      const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
      if (Buffer.byteLength(updated) > maxFileBytes) throw new Error(`Updated file exceeds ${maxFileBytes} bytes.`);
      await fs.writeFile(target, updated, 'utf8');
      return { path: relativePath, replacements: 1 };
    },
  });

  return [writeFile, replaceText];
}

export function createShellTools(
  context: ToolFactoryContext,
  options: { allowedCommands: string[]; timeoutMs?: number; maxOutputBytes?: number },
): Tool[] {
  const allowed = new Set(options.allowedCommands);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 120_000;

  return [
    tool({
      name: 'exec_command',
      description: `Execute a command without a shell. Allowed commands: ${[...allowed].join(', ') || '(none)'}.`,
      parameters: z.object({
        command: z.string().min(1),
        args: z.array(z.string()).max(100).optional(),
        cwd: z.string().optional(),
      }),
      execute: async ({ command, args = [], cwd = '.' }) => {
        if (!allowed.has(command)) throw new Error(`Command is not allowlisted: ${command}`);
        const workingDirectory = await resolveExistingNonSymlink(context.workspaceRoot, cwd, 'directory');
        await context.permissions.authorize({
          capabilityId: 'shell.exec',
          risk: 'exec',
          action: command,
          details: `${command} ${args.join(' ')}`.trim(),
        });
        return runCommand(command, args, workingDirectory, timeoutMs, maxOutputBytes);
      },
    }),
  ];
}

export function createWebFetchTools(
  context: ToolFactoryContext,
  options: { allowedDomains: string[]; timeoutMs?: number; maxResponseBytes?: number },
): Tool[] {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxResponseBytes = options.maxResponseBytes ?? 500_000;

  return [
    tool({
      name: 'fetch_url',
      description: `Fetch text or JSON with HTTP GET. Allowed domains: ${options.allowedDomains.join(', ')}.`,
      parameters: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        await context.permissions.authorize({
          capabilityId: 'web.fetch',
          risk: 'network',
          action: 'GET',
          details: url,
        });
        return fetchAllowedUrl(url, {
          allowedDomains: options.allowedDomains,
          timeoutMs,
          maxResponseBytes,
        });
      },
    }),
  ];
}

export type WebSearchAdapter = (query: string) => Promise<unknown>;

export function createWebSearchTool(
  context: ToolFactoryContext,
  adapter: WebSearchAdapter,
): Tool {
  return tool({
    name: 'search_web',
    description: 'Search the web using the configured search adapter.',
    parameters: z.object({ query: z.string().min(1).max(2_000) }),
    execute: async ({ query }) => {
      await context.permissions.authorize({
        capabilityId: 'web.search',
        risk: 'network',
        action: 'search',
        details: query,
      });
      return adapter(query);
    },
  });
}

export function createHttpWebSearchAdapter(options: {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}): WebSearchAdapter {
  return async (query) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function fetchAllowedUrl(
  input: string,
  options: {
    allowedDomains: string[];
    timeoutMs: number;
    maxResponseBytes: number;
    fetchImpl?: typeof fetch;
  },
): Promise<{ url: string; contentType: string; body: string; bytesRead: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = validateUrl(input, options.allowedDomains);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect response did not include Location.');
        if (redirects === 5) throw new Error('Too many redirects.');
        url = validateUrl(new URL(location, url).toString(), options.allowedDomains);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}.`);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!(contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('+json'))) {
        throw new Error(`Unsupported content type: ${contentType || '(missing)'}.`);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > options.maxResponseBytes) {
        throw new Error(`Response exceeds ${options.maxResponseBytes} bytes.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > options.maxResponseBytes) throw new Error(`Response exceeds ${options.maxResponseBytes} bytes.`);
      return {
        url,
        contentType,
        body: new TextDecoder().decode(bytes),
        bytesRead: bytes.byteLength,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Unreachable redirect state.');
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ command: string; exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failed = false;

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes && !failed) {
        failed = true;
        child.kill('SIGKILL');
        reject(new Error(`Command output exceeded ${maxOutputBytes} bytes.`));
      } else if (!failed) {
        target.push(chunk);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      if (!failed) reject(error);
      failed = true;
    });
    const timer = setTimeout(() => {
      if (!failed) {
        failed = true;
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeoutMs} ms.`));
      }
    }, timeoutMs);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (failed) return;
      resolve({
        command,
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function validateUrl(input: string, allowedDomains: string[]): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) URLs are allowed.');
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedDomains.some((entry) => {
    const domain = entry.toLowerCase();
    return domain.startsWith('*.') ? hostname.endsWith(domain.slice(1)) && hostname !== domain.slice(2) : hostname === domain;
  });
  if (!allowed) throw new Error(`Domain is not allowlisted: ${hostname}`);
  return url.toString();
}

async function prepareWritePath(rootInput: string, relativeInput: string): Promise<string> {
  const root = await fs.realpath(path.resolve(rootInput));
  const parts = safeRelativeParts(relativeInput);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe parent path: ${relativeInput}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
  }
  const target = path.join(current, parts.at(-1)!);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.isDirectory()) throw new Error(`Unsafe target path: ${relativeInput}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

async function resolveExistingNonSymlink(
  rootInput: string,
  relativeInput: string,
  expected: 'file' | 'directory',
): Promise<string> {
  const root = await fs.realpath(path.resolve(rootInput));
  if ((relativeInput === '.' || relativeInput === './') && expected === 'directory') return root;
  const parts = safeRelativeParts(relativeInput);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relativeInput}`);
  }
  const real = await fs.realpath(current);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes workspace: ${relativeInput}`);
  const stat = await fs.stat(real);
  if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`${relativeInput} is not a ${expected}.`);
  }
  return real;
}

function safeRelativeParts(input: string): string[] {
  if (!input || path.isAbsolute(input)) throw new Error(`Only relative workspace paths are allowed: ${input}`);
  const normalized = input.replaceAll('\\', '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) throw new Error(`Path escapes workspace: ${input}`);
  return parts;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
