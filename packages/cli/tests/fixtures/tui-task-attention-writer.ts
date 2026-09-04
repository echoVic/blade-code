import { writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
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
});
if (selected === 'a') {
  const target = `${storageRoot}/tui-task-attention-v1.json`;
  const release = await lockfile.lock(target, { realpath: false });
  await writeFile(`${storageRoot}/writer-ready`, 'ready');
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await release();
  }
}
await store.acknowledge(summary);
