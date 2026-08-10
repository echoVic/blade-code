import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextManager } from '../../../src/context/ContextManager.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService durable project instruction provenance', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-rules-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-rules-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  it('persists and forks a static instruction digest without raw content', async () => {
    const digest = 'a'.repeat(64);
    const created = await SessionService.createSessionMetadata(
      'rules-parent',
      workspace,
      {
        taskStatus: 'completed',
        projectInstructionsDigest: digest,
      }
    );
    expect(created.projectInstructionsDigest).toBe(digest);

    const fork = await SessionService.forkSession(created.sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'rules-child',
    });
    expect(fork.metadata.projectInstructionsDigest).toBe(digest);

    const transcript = await readFile(
      getSessionFilePath(workspace, created.sessionId),
      'utf8'
    );
    expect(transcript).toContain(`"projectInstructionsDigest":"${digest}"`);
    expect(transcript).not.toContain('CONTEXTUAL_RULE_BODY');
  });

  it('rejects malformed provenance before appending an event', async () => {
    const created = await SessionService.createSessionMetadata(
      'rules-invalid',
      workspace,
      { taskStatus: 'completed' }
    );
    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');

    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        projectInstructionsDigest: 'not-a-digest',
      })
    ).rejects.toThrow('Invalid session project instructions digest');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('restores system rule references without persisting the rule body', async () => {
    const sessionId = 'rules-reference';
    await SessionService.createSessionMetadata(sessionId, workspace, {
      taskStatus: 'completed',
    });
    const manager = new ContextManager({ projectPath: workspace });
    await manager.saveMessage(
      sessionId,
      'system',
      '<contextual-project-instructions-ref count="1" />',
      null,
      {
        contextualProjectRules: true,
        ruleReferences: [
          {
            id: 'project:rule-one',
            relativePath: '.claude/rules/typescript.md',
            source: 'project',
            contentSha256: 'b'.repeat(64),
          },
        ],
        triggerPaths: ['src/index.ts'],
      }
    );

    const messages = await SessionService.loadSession(sessionId, workspace);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: 'system',
        content: '<contextual-project-instructions-ref count="1" />',
        metadata: expect.objectContaining({
          contextualProjectRules: true,
        }),
      })
    );
    expect(
      await readFile(getSessionFilePath(workspace, sessionId), 'utf8')
    ).not.toContain('CONTEXTUAL_RULE_BODY');
  });
});
