import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod';

const ignoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  'coverage',
  'dist',
  'node_modules',
  'runs',
]);

export type RepositoryToolOptions = {
  root: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxSearchMatches?: number;
};

export async function createRepositoryTools(options: RepositoryToolOptions) {
  const root = await fs.realpath(path.resolve(options.root));
  const maxFiles = options.maxFiles ?? 500;
  const maxFileBytes = options.maxFileBytes ?? 120_000;
  const maxSearchMatches = options.maxSearchMatches ?? 100;

  const listFiles = tool({
    name: 'list_files',
    description: 'List repository files by relative path. Use includeText or extensions to narrow results.',
    parameters: z.object({
      directory: z.string().optional().describe('Relative directory to scan. Defaults to repository root.'),
      includeText: z.string().optional().describe('Only include paths containing this text.'),
      extensions: z.array(z.string()).optional().describe('Extensions like ".ts" or "md".'),
      maxFiles: z.number().int().positive().max(maxFiles).optional(),
    }),
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const files = await collectFiles(root, directory, input.maxFiles ?? maxFiles);
      const normalizedExtensions = input.extensions?.map((extension) =>
        extension.startsWith('.') ? extension : `.${extension}`,
      );
      return files.filter((file) => {
        if (input.includeText && !file.includes(input.includeText)) return false;
        if (normalizedExtensions?.length && !normalizedExtensions.includes(path.extname(file))) return false;
        return true;
      });
    },
  });

  const readFile = tool({
    name: 'read_file',
    description: 'Read a UTF-8 text file by repository-relative path. Large files are truncated.',
    parameters: z.object({
      path: z.string(),
      maxBytes: z.number().int().positive().max(maxFileBytes).optional(),
    }),
    execute: async (input) => {
      const filePath = await resolveInsideRoot(root, input.path);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
      const bytes = Math.min(input.maxBytes ?? maxFileBytes, maxFileBytes, stat.size);
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        return {
          path: input.path,
          truncated: stat.size > bytesRead,
          bytesRead,
          content,
        };
      } finally {
        await handle.close();
      }
    },
  });

  const searchText = tool({
    name: 'search_text',
    description: 'Search repository text files for a literal string. Returns relative paths and line snippets.',
    parameters: z.object({
      query: z.string().min(1),
      directory: z.string().optional(),
      maxMatches: z.number().int().positive().max(maxSearchMatches).optional(),
    }),
    execute: async (input) => {
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const files = await collectFiles(root, input.directory ?? '.', maxFiles);
      const limit = Math.min(input.maxMatches ?? maxSearchMatches, maxSearchMatches);

      for (const relativePath of files) {
        if (matches.length >= limit) break;
        const absolutePath = await resolveInsideRoot(root, relativePath);
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile() || stat.size > maxFileBytes) continue;
        const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
        if (!content.includes(input.query)) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (lines[i].includes(input.query)) {
            matches.push({
              path: relativePath,
              line: i + 1,
              text: lines[i].slice(0, 500),
            });
          }
        }
      }

      return matches;
    },
  });

  return [listFiles, readFile, searchText];
}

export async function collectFiles(root: string, relativeDirectory: string, maxFiles: number): Promise<string[]> {
  const start = await resolveInsideRoot(root, relativeDirectory);
  const stat = await fs.stat(start);
  if (!stat.isDirectory()) throw new Error(`${relativeDirectory} is not a directory.`);

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, '/');
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await visit(start);
  return files.sort();
}

export async function resolveInsideRoot(root: string, relativeInput: string): Promise<string> {
  if (path.isAbsolute(relativeInput)) {
    throw new Error(`Absolute paths are not allowed: ${relativeInput}`);
  }
  const resolved = path.resolve(root, relativeInput);
  const real = await fs.realpath(resolved);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${relativeInput}`);
  }
  return real;
}
