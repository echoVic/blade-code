import { stat, writeFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import type { SessionSurfaceSummary } from '../../src/api/sessionSurfaceSchemas.js';
import { TuiTaskAttentionStore } from '../../src/ui/services/TuiTaskAttentionStore.js';

const storageRoot = process.argv[2];
const selected = process.argv[3];
if (!storageRoot || (selected !== 'a' && selected !== 'b')) {
  throw new Error('usage: tui-task-attention-writer <storage-root> <a|b>');
}

const sessionId = `concurrent-${selected}`;
const projectPath = `/workspace/concurrent-${selected}`;
const summary: SessionSurfaceSummary = {
  locator: {
    version: 2,
    sessionId,
    workspace: { kind: 'local', projectPath },
  },
  displayCwd: projectPath,
  rootId: sessionId,
  taskStatus: 'completed',
  taskCompletedAt: '2026-09-04T12:30:00.000Z',
  messageCount: 1,
  firstMessageTime: '2026-09-04T12:00:00.000Z',
  lastMessageTime: '2026-09-04T12:01:00.000Z',
  hasErrors: false,
  capabilities: {
    connection: 'local',
    history: { read: true, fork: true },
    turn: { start: true },
    files: { readText: true, writeText: true, browse: 'tree' },
    terminal: { mode: 'interactive', owner: 'local' },
  },
};

const store = new TuiTaskAttentionStore({
  filePath: `${storageRoot}/tui-task-attention-v1.json`,
  ...(selected === 'a'
    ? {
        writeFile: async (
          filePath: string,
          data: string,
          options: { mode: number }
        ) => {
          await writeFile(`${storageRoot}/writer-a-lock-held`, 'held');
          while (true) {
            try {
              await stat(`${storageRoot}/writer-a-release`);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
          await writeFileAtomic(filePath, data, options);
        },
      }
    : {}),
});
if (selected === 'b') {
  await writeFile(`${storageRoot}/writer-b-attempt`, 'attempt');
}
await store.acknowledge(summary);
if (selected === 'b') {
  await writeFile(`${storageRoot}/writer-b-completed`, 'completed');
}
