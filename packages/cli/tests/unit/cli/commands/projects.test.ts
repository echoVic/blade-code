import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BoundProject } from '../../../../src/api/schemas.js';
import {
  formatProjectList,
  type ProjectsCommandDependencies,
  runProjectsAdd,
  runProjectsList,
  runProjectsRemove,
} from '../../../../src/commands/projects.js';

function project(overrides: Partial<BoundProject> = {}): BoundProject {
  return {
    path: '/workspace/blade',
    name: 'blade',
    gitBranch: 'main',
    available: true,
    isCurrent: true,
    boundAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

function dependencies(projects: BoundProject[] = [project()]) {
  const lines: string[] = [];
  const registry = {
    list: vi.fn().mockResolvedValue(projects),
    bind: vi.fn().mockImplementation(async (projectPath: string, currentPath: string) =>
      project({
        path: projectPath,
        name: path.basename(projectPath),
        isCurrent: projectPath === currentPath,
      })
    ),
    unbind: vi.fn().mockResolvedValue(true),
  };
  const value: ProjectsCommandDependencies = {
    registry,
    currentWorkspace: () => '/workspace/blade',
    inputCwd: () => '/workspace',
    write: (line) => lines.push(line),
  };
  return { value, registry, lines };
}

describe('commands/projects', () => {
  it('formats current, branch, and unavailable project state', () => {
    expect(
      formatProjectList([
        project(),
        project({
          path: '/workspace/missing',
          name: 'missing',
          gitBranch: undefined,
          available: false,
          isCurrent: false,
        }),
      ])
    ).toBe(
      '* blade · main\n  /workspace/blade\n' +
        '  missing · unavailable\n  /workspace/missing'
    );
  });

  it('lists projects in human and machine-readable formats', async () => {
    const human = dependencies();
    await runProjectsList({}, human.value);
    expect(human.registry.list).toHaveBeenCalledWith('/workspace/blade');
    expect(human.lines).toEqual(['* blade · main\n  /workspace/blade']);

    const json = dependencies();
    await runProjectsList({ json: true }, json.value);
    expect(JSON.parse(json.lines[0]!)).toEqual([project()]);
  });

  it('resolves relative input paths for add and remove', async () => {
    const add = dependencies();
    await runProjectsAdd({ path: './other' }, add.value);
    expect(add.registry.bind).toHaveBeenCalledWith(
      '/workspace/other',
      '/workspace/blade'
    );
    expect(add.lines).toEqual(['Bound project: /workspace/other']);

    const remove = dependencies();
    await runProjectsRemove({ path: './other', json: true }, remove.value);
    expect(remove.registry.unbind).toHaveBeenCalledWith('/workspace/other');
    expect(JSON.parse(remove.lines[0]!)).toEqual({
      path: '/workspace/other',
      removed: true,
    });
  });

  it('reports idempotent removal without treating it as an error', async () => {
    const result = dependencies();
    result.registry.unbind.mockResolvedValue(false);

    await expect(
      runProjectsRemove({ path: '/workspace/other' }, result.value)
    ).resolves.toBe(false);
    expect(result.lines).toEqual(['Project was not bound: /workspace/other']);
  });
});
