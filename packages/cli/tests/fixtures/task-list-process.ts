import * as path from 'node:path';
import { withTaskListFileLock } from '../../src/tools/builtin/task/TaskListFileLock.js';
import { TaskListManager } from '../../src/tools/builtin/task/TaskListManager.js';

const [mode, configDir, taskListId, countText, processLabel] = process.argv.slice(2);
if (!mode || !configDir || !taskListId) {
  process.exit(2);
}

const taskFile = path.join(
  configDir,
  'tasks',
  `${taskListId}-agent-${taskListId}.json`
);

if (mode === 'create') {
  const count = Number(countText);
  if (!Number.isInteger(count) || count < 1 || !processLabel) {
    process.exit(2);
  }
  for (let index = 0; index < count; index++) {
    await TaskListManager.getInstance(taskListId, configDir).createTask({
      subject: `${processLabel}-${index}`,
      description: 'Cross-process task-list write',
    });
  }
  process.stdout.write('CREATED\n');
} else if (mode === 'hold-lock') {
  await withTaskListFileLock(taskFile, async () => {
    process.stdout.write('LOCKED\n');
    await new Promise(() => undefined);
  });
} else {
  process.exit(2);
}
