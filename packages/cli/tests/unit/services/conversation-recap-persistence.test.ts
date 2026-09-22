import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');
vi.unmock('fs');
vi.unmock('fs/promises');

it('persists recap metadata on both the message and replayable text part', async () => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'blade-recap-'));
  const sessionId = 'recap-persistence';
  try {
    const store = new PersistentStore(projectPath);
    await store.saveMessage(sessionId, 'user', 'Ship the feature.');
    await store.saveMessage(
      sessionId,
      'assistant',
      'Tests pass; review is pending.',
      null,
      { conversationRecap: true }
    );
    const records = (await readFile(getSessionFilePath(projectPath, sessionId), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'part_created',
          data: expect.objectContaining({
            payload: {
              text: 'Tests pass; review is pending.',
              conversationRecap: true,
            },
          }),
        }),
      ])
    );
    expect(
      await SessionService.loadSessionModelContext(sessionId, projectPath)
    ).toEqual([{ role: 'user', content: 'Ship the feature.' }]);
    expect(await SessionService.loadSession(sessionId, projectPath)).toHaveLength(2);
  } finally {
    await SessionService.deleteSession(sessionId, projectPath);
    await rm(projectPath, { recursive: true, force: true });
  }
});
