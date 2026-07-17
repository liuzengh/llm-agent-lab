import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles, resolveInsideRoot } from '../src/tools/repository.js';

describe('repository path isolation', () => {
  it('lists normal files and ignores heavy directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-tools-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const ok = true;');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');

    const files = await collectFiles(await fs.realpath(root), '.', 20);
    expect(files).toEqual(['src/index.ts']);
  });

  it('rejects absolute paths and symlink escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));

    await expect(resolveInsideRoot(await fs.realpath(root), '/etc/passwd')).rejects.toThrow(/Absolute paths/);
    await expect(resolveInsideRoot(await fs.realpath(root), 'escape.txt')).rejects.toThrow(/escapes/);
  });
});
