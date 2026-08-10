import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSessionMarkdownExport } from '../../../src/services/SessionExportWriter.js';
import type { SessionMarkdownExport } from '../../../src/services/SessionMarkdownExporter.js';

const exported: SessionMarkdownExport = {
  filename: 'blade-session-test.md',
  markdown: '# Blade conversation\n',
  contentSha256: 'a'.repeat(64),
  contentBytes: 20,
  messageCount: 1,
  activityCount: 0,
  reasoningIncluded: false,
  reasoningCount: 0,
  redactionCount: 0,
};

describe('SessionExportWriter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('creates a private default export and refuses to overwrite it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-export-writer-'));
    roots.push(root);
    const output = await writeSessionMarkdownExport(root, exported);

    expect(output).toBe(path.join(root, exported.filename));
    expect(await readFile(output, 'utf8')).toBe(exported.markdown);
    if (process.platform !== 'win32') {
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }

    await expect(
      writeSessionMarkdownExport(root, {
        ...exported,
        markdown: 'must not replace\n',
      })
    ).rejects.toThrow('already exists');
    expect(await readFile(output, 'utf8')).toBe(exported.markdown);
  });

  it('resolves relative paths, creates parents, and preserves existing files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-export-relative-'));
    roots.push(root);
    const output = await writeSessionMarkdownExport(
      root,
      exported,
      'reports/session.md'
    );
    expect(output).toBe(path.join(root, 'reports', 'session.md'));

    const existing = path.join(root, 'existing.md');
    await writeFile(existing, 'existing\n');
    await expect(writeSessionMarkdownExport(root, exported, existing)).rejects.toThrow(
      'already exists'
    );
    expect(await readFile(existing, 'utf8')).toBe('existing\n');
  });

  it('rejects invalid cwd and null-byte paths', async () => {
    await expect(writeSessionMarkdownExport('relative', exported)).rejects.toThrow(
      'cwd must be absolute'
    );
    await expect(
      writeSessionMarkdownExport('/tmp', exported, 'bad\0path.md')
    ).rejects.toThrow('null byte');
  });
});
