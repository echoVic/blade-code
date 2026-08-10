import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ProjectRuleReference,
  resolveWorkspaceProjectRules,
} from '../../../src/agent/resources/WorkspaceProjectRules.js';

describe('workspace contextual project rules', () => {
  const temporaryDirectories: string[] = [];

  async function repository(name: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), name));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, '.git'), { recursive: true });
    return root;
  }

  async function fixture(root: string, relativePath: string, content: string) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads static, local, override, nested, and conditional rules in scope order', async () => {
    const root = await repository('blade-project-rules-');
    const workspace = path.join(root, 'packages', 'service');
    const target = path.join(workspace, 'src', 'handler.ts');
    await mkdir(path.dirname(target), { recursive: true });
    await Promise.all([
      fixture(root, 'CLAUDE.md', 'ROOT_CLAUDE'),
      fixture(root, 'AGENTS.md', 'SHADOWED_AGENTS'),
      fixture(root, 'AGENTS.override.md', 'ROOT_OVERRIDE'),
      fixture(root, 'BLADE.md', 'ROOT_BLADE'),
      fixture(root, 'CLAUDE.local.md', 'ROOT_LOCAL'),
      fixture(root, '.claude/rules/general.md', 'ROOT_UNCONDITIONAL'),
      fixture(
        root,
        '.claude/rules/typescript.md',
        '---\npaths:\n  - packages/service/src/**/*.ts\n---\nROOT_TYPESCRIPT'
      ),
      fixture(
        root,
        '.claude/rules/python.md',
        '---\npaths: "**/*.py"\n---\nROOT_PYTHON'
      ),
      fixture(root, 'packages/service/CLAUDE.md', 'NESTED_CLAUDE'),
      fixture(root, 'packages/service/.blade/rules/general.md', 'NESTED_BLADE_RULE'),
      fixture(
        root,
        'packages/service/.claude/rules/src.md',
        '---\npaths: src/**/*.ts\n---\nNESTED_TYPESCRIPT'
      ),
    ]);

    const catalog = await resolveWorkspaceProjectRules(root, {
      projectTrusted: true,
    });
    const staticRules = catalog.staticRules(root);
    const loaded = new Set(staticRules.references.map((item) => item.id));
    const contextual = catalog.contextualRules(root, [target], loaded);

    expect(staticRules.content).toContain('ROOT_CLAUDE');
    expect(staticRules.content).toContain('ROOT_OVERRIDE');
    expect(staticRules.content).toContain('ROOT_BLADE');
    expect(staticRules.content).toContain('ROOT_UNCONDITIONAL');
    expect(staticRules.content).toContain('ROOT_LOCAL');
    expect(staticRules.content).not.toContain('SHADOWED_AGENTS');
    expect(staticRules.content).not.toContain('ROOT_TYPESCRIPT');
    expect(staticRules.content).not.toContain('NESTED_CLAUDE');

    expect(contextual.content).toContain('ROOT_TYPESCRIPT');
    expect(contextual.content).toContain('NESTED_CLAUDE');
    expect(contextual.content).toContain('NESTED_BLADE_RULE');
    expect(contextual.content).toContain('NESTED_TYPESCRIPT');
    expect(contextual.content).not.toContain('ROOT_PYTHON');
    expect(contextual.triggerPaths).toEqual(['packages/service/src/handler.ts']);
    expect(contextual.files.map((item) => item.relativePath)).toEqual([
      '.claude/rules/typescript.md',
      'packages/service/CLAUDE.md',
      'packages/service/.claude/rules/src.md',
      'packages/service/.blade/rules/general.md',
    ]);
  });

  it('loads the repository ancestors when Blade starts in a nested directory', async () => {
    const root = await repository('blade-project-rules-nested-');
    const workspace = path.join(root, 'packages', 'service');
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      fixture(root, 'AGENTS.md', 'ROOT_RULE'),
      fixture(root, 'packages/service/BLADE.md', 'WORKSPACE_RULE'),
      fixture(root, 'packages/service/.claude/rules/local.md', 'NESTED_RULE_DIRECTORY'),
    ]);

    const catalog = await resolveWorkspaceProjectRules(workspace, {
      projectTrusted: true,
    });
    const rules = catalog.staticRules(workspace);

    expect(catalog.projectRoot).toBe(await realpath(root));
    expect(rules.content).toContain('ROOT_RULE');
    expect(rules.content).toContain('WORKSPACE_RULE');
  });

  it('returns an empty catalog before trust and ignores unsafe files', async () => {
    const root = await repository('blade-project-rules-security-');
    const outside = await repository('blade-project-rules-outside-');
    await Promise.all([
      fixture(root, 'CLAUDE.md', 'TRUSTED_ONLY'),
      fixture(root, '.claude/rules/hidden.md', 'SAFE\u200bHIDDEN'),
      fixture(outside, 'outside.md', 'OUTSIDE_RULE'),
      mkdir(path.join(root, '.blade', 'rules'), { recursive: true }),
    ]);
    await symlink(
      path.join(outside, 'outside.md'),
      path.join(root, '.blade', 'rules', 'linked.md')
    );

    const untrusted = await resolveWorkspaceProjectRules(root, {
      projectTrusted: false,
    });
    expect(untrusted.list()).toEqual([]);

    const trusted = await resolveWorkspaceProjectRules(root, {
      projectTrusted: true,
    });
    expect(trusted.staticRules(root).content).toContain('TRUSTED_ONLY');
    expect(trusted.staticRules(root).content).not.toContain('SAFE\u200bHIDDEN');
    expect(trusted.staticRules(root).content).not.toContain('OUTSIDE_RULE');
  });

  it('freezes snapshots and fails closed when durable provenance drifts', async () => {
    const root = await repository('blade-project-rules-snapshot-');
    const target = path.join(root, 'src', 'index.ts');
    await mkdir(path.dirname(target), { recursive: true });
    const rulePath = '.claude/rules/typescript.md';
    await fixture(root, rulePath, '---\npaths: src/**/*.ts\n---\nRULE_VERSION_ONE');
    const catalog = await resolveWorkspaceProjectRules(root, {
      projectTrusted: true,
    });
    const snapshot = catalog.snapshot();
    const resolution = snapshot.contextualRules(root, [target], new Set());
    const references = resolution.references;

    await fixture(root, rulePath, '---\npaths: src/**/*.ts\n---\nRULE_VERSION_TWO');
    const refreshed = await resolveWorkspaceProjectRules(root, {
      projectTrusted: true,
    });

    expect(snapshot.hydrate(references).content).toContain('RULE_VERSION_ONE');
    expect(refreshed.contextualRules(root, [target], new Set()).content).toContain(
      'RULE_VERSION_TWO'
    );
    expect(() => refreshed.hydrate(references)).toThrow(
      'Project rule provenance mismatch'
    );
    const malformed: ProjectRuleReference[] = [
      { ...references[0]!, contentSha256: 'f'.repeat(64) },
    ];
    expect(() => snapshot.hydrate(malformed)).toThrow(
      'Project rule provenance mismatch'
    );
  });
});
