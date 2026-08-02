import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../../../src/bootstrap/state.js';
import { buildSystemPrompt } from '../../../../src/prompts/builder.js';

describe('project instructions', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads scoped instructions from the repository root to the working directory', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'blade-project-instructions-'));
    temporaryDirectories.push(parent);

    const repository = path.join(parent, 'repository');
    const workingDirectory = path.join(repository, 'packages', 'service');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(workingDirectory, { recursive: true });

    await Promise.all([
      writeFile(path.join(parent, 'AGENTS.md'), 'OUTSIDE_REPOSITORY_MARKER'),
      writeFile(path.join(repository, 'CLAUDE.md'), 'ROOT_CLAUDE_MARKER'),
      writeFile(path.join(repository, 'AGENTS.md'), 'ROOT_AGENTS_MARKER'),
      writeFile(path.join(repository, 'BLADE.md'), 'ROOT_BLADE_MARKER'),
      writeFile(path.join(workingDirectory, 'AGENTS.md'), 'SCOPED_AGENTS_MARKER'),
      writeFile(path.join(workingDirectory, 'BLADE.md'), 'SCOPED_BLADE_MARKER'),
    ]);

    const result = await buildSystemPrompt({
      projectPath: workingDirectory,
      includeEnvironment: false,
    });

    const markers = [
      'ROOT_CLAUDE_MARKER',
      'ROOT_AGENTS_MARKER',
      'ROOT_BLADE_MARKER',
      'SCOPED_AGENTS_MARKER',
      'SCOPED_BLADE_MARKER',
    ];
    const positions = markers.map((marker) => result.prompt.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(result.prompt).not.toContain('OUTSIDE_REPOSITORY_MARKER');
  });

  it('bounds instruction content while preserving the most specific rules', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'blade-instruction-budget-'));
    temporaryDirectories.push(repository);

    const workingDirectory = path.join(repository, 'packages', 'service');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(workingDirectory, { recursive: true });
    await writeFile(
      path.join(repository, 'BLADE.md'),
      `ROOT_RULE\n${'x'.repeat(64 * 1024)}`
    );
    await writeFile(
      path.join(workingDirectory, 'BLADE.md'),
      'MOST_SPECIFIC_RULE_MUST_SURVIVE'
    );

    const result = await buildSystemPrompt({
      projectPath: workingDirectory,
      includeEnvironment: false,
    });
    const source = result.sources.find((item) => item.name === 'project_instructions');

    expect(result.prompt).toContain('MOST_SPECIFIC_RULE_MUST_SURVIVE');
    expect(source).toMatchObject({ loaded: true });
    expect(source?.length).toBeLessThan(34 * 1024);
  });

  it('escapes instruction provenance paths without changing file content', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'blade-path-escaping-'));
    temporaryDirectories.push(repository);

    const workingDirectory = path.join(repository, 'packages', 'service & api');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(workingDirectory, { recursive: true });
    await writeFile(path.join(workingDirectory, 'BLADE.md'), 'USE_A < USE_B && USE_C');

    const result = await buildSystemPrompt({
      projectPath: workingDirectory,
      includeEnvironment: false,
    });

    expect(result.prompt).toContain('path="packages/service &amp; api/BLADE.md"');
    expect(result.prompt).toContain('USE_A < USE_B && USE_C');
  });

  it('keeps the invocation directory scope after bootstrap selects the repository root', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'blade-bootstrap-rules-'));
    temporaryDirectories.push(repository);

    const invocationDirectory = path.join(repository, 'packages', 'service');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(invocationDirectory, { recursive: true });
    await writeFile(path.join(repository, 'AGENTS.md'), 'BOOTSTRAP_ROOT_RULE');
    await writeFile(
      path.join(invocationDirectory, 'BLADE.md'),
      'BOOTSTRAP_SCOPED_RULE'
    );

    const previousCwd = getCwdState();
    const previousOriginalCwd = getOriginalCwd();
    setCwdState(repository);
    setOriginalCwd(invocationDirectory);

    try {
      const result = await buildSystemPrompt({
        projectPath: repository,
        includeEnvironment: false,
      });

      expect(result.prompt).toContain('BOOTSTRAP_ROOT_RULE');
      expect(result.prompt).toContain('BOOTSTRAP_SCOPED_RULE');
    } finally {
      setCwdState(previousCwd);
      setOriginalCwd(previousOriginalCwd);
    }
  });
});
