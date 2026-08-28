import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index';
import { TaskListManager } from '../../../../../src/tools/builtin/task/TaskListManager';
import { createTaskListTools } from '../../../../../src/tools/builtin/task/index';

async function createTempConfigDir() {
  return fs.mkdtemp(path.join(tmpdir(), 'blade-task-list-test-'));
}

function createAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function getTool(sessionId: string, configDir: string, name: string) {
  const tool = createTaskListTools({ sessionId, configDir }).find(
    (candidate) => candidate.name === name
  );
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as any;
}

describe('task list tools persistence', () => {
  it('creates tasks in session-scoped files under ~/.blade/tasks', async () => {
    const configDir = await createTempConfigDir();

    try {
      const createTool = getTool('session-a', configDir, 'TaskCreate');
      const invocation = createTool.build({
        subject: 'Run tests',
        description: 'Run targeted tests',
        activeForm: 'Running tests',
        priority: 'high',
      });

      const result = await invocation.execute(createAbortSignal());
      expect(result.success).toBe(true);

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'tasks', 'session-a-agent-session-a.json'),
          'utf-8'
        )
      );
      expect(stored.tasks[0]).toMatchObject({
        id: '1',
        subject: 'Run tests',
        status: 'pending',
        priority: 'high',
      });
      const mode = (
        await fs.stat(path.join(configDir, 'tasks', 'session-a-agent-session-a.json'))
      ).mode;
      expect(mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('isolates tasks between sessions', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-1', configDir, 'TaskCreate')
        .build({ subject: 'Task one', description: 'First session task' })
        .execute(createAbortSignal());
      await getTool('session-2', configDir, 'TaskCreate')
        .build({ subject: 'Task two', description: 'Second session task' })
        .execute(createAbortSignal());

      const sessionOne = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'tasks', 'session-1-agent-session-1.json'),
          'utf-8'
        )
      );
      const sessionTwo = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'tasks', 'session-2-agent-session-2.json'),
          'utf-8'
        )
      );

      expect(sessionOne.tasks[0].subject).toBe('Task one');
      expect(sessionTwo.tasks[0].subject).toBe('Task two');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('can share tasks across sessions with a taskListId context', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('agent-a', configDir, 'TaskCreate')
        .build({ subject: 'Shared task', description: 'Visible to the team' })
        .execute(createAbortSignal(), undefined, {
          sessionId: 'agent-a',
          taskListId: 'team-a',
        });

      const listResult = await getTool('agent-b', configDir, 'TaskList')
        .build({})
        .execute(createAbortSignal(), undefined, {
          sessionId: 'agent-b',
          taskListId: 'team-a',
        });
      const listContent = listResult.llmContent as {
        tasks: Array<{ subject: string }>;
      };

      expect(listContent.tasks).toEqual([
        expect.objectContaining({ subject: 'Shared task' }),
      ]);
      await expect(
        fs.readFile(path.join(configDir, 'tasks', 'team-a-agent-team-a.json'), 'utf-8')
      ).resolves.toContain('Shared task');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('prefers the shared Team scope over the active Goal scope', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Goal task', description: 'Belongs to the goal' })
        .execute(createAbortSignal(), undefined, {
          sessionId: 'session-a',
          goalTaskListId: 'goal:session-a:goal-1',
        });
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Team task', description: 'Belongs to the team' })
        .execute(createAbortSignal(), undefined, {
          sessionId: 'session-a',
          taskListId: 'team-1',
          goalTaskListId: 'goal:session-a:goal-1',
        });

      const goalTasks = await TaskListManager.getInstance(
        'goal:session-a:goal-1',
        configDir
      ).listTasks();
      const teamTasks = await TaskListManager.getInstance(
        'team-1',
        configDir
      ).listTasks();
      expect(goalTasks.map((task) => task.subject)).toEqual(['Goal task']);
      expect(teamTasks.map((task) => task.subject)).toEqual(['Team task']);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('updates and lists current tasks', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Build project', description: 'Run the build' })
        .execute(createAbortSignal());

      const updateResult = await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '1', status: 'completed' })
        .execute(createAbortSignal());
      const updateContent = updateResult.llmContent as {
        task: { subject: string; status: string };
        stats: { completed: number };
      };

      expect(updateContent.task.status).toBe('completed');
      expect(updateContent.stats.completed).toBe(1);

      const listResult = await getTool('session-a', configDir, 'TaskList')
        .build({})
        .execute(createAbortSignal());
      const listContent = listResult.llmContent as {
        tasks: Array<{ subject: string; status: string }>;
      };

      expect(listContent.tasks).toHaveLength(1);
      expect(listContent.tasks[0]).toMatchObject({
        subject: 'Build project',
        status: 'completed',
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('gets existing tasks and returns null for missing tasks', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Inspect logs', description: 'Review failing test logs' })
        .execute(createAbortSignal());

      const getResult = await getTool('session-a', configDir, 'TaskGet')
        .build({ taskId: '1' })
        .execute(createAbortSignal());
      const getContent = getResult.llmContent as {
        task: { id: string; subject: string; status: string };
      };

      expect(getContent.task).toMatchObject({
        id: '1',
        subject: 'Inspect logs',
        status: 'pending',
      });

      const missingResult = await getTool('session-a', configDir, 'TaskGet')
        .build({ taskId: 'missing' })
        .execute(createAbortSignal());
      const missingContent = missingResult.llmContent as { task: unknown };

      expect(missingContent.task).toBeNull();
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('deletes tasks through TaskUpdate and removes dependency references', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Prepare release', description: 'Prepare release notes' })
        .execute(createAbortSignal());
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Ship release', description: 'Publish the release' })
        .execute(createAbortSignal());
      await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '1', addBlocks: ['2'] })
        .execute(createAbortSignal());

      const deleteResult = await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '1', status: 'deleted' })
        .execute(createAbortSignal());
      const deleteContent = deleteResult.llmContent as {
        success: boolean;
        tasks: Array<{ id: string; blockedBy: string[] }>;
        stats: { total: number };
      };

      expect(deleteContent.success).toBe(true);
      expect(deleteContent.stats.total).toBe(1);
      expect(deleteContent.tasks).toEqual([
        expect.objectContaining({ id: '2', blockedBy: [] }),
      ]);

      const listResult = await getTool('session-a', configDir, 'TaskList')
        .build({})
        .execute(createAbortSignal());
      const listContent = listResult.llmContent as {
        tasks: Array<{ id: string; blockedBy: string[] }>;
      };

      expect(listContent.tasks).toEqual([
        expect.objectContaining({ id: '2', blockedBy: [] }),
      ]);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('keeps dependency edges bidirectional without duplicates', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Build package', description: 'Compile package output' })
        .execute(createAbortSignal());
      await getTool('session-a', configDir, 'TaskCreate')
        .build({ subject: 'Run smoke test', description: 'Verify package output' })
        .execute(createAbortSignal());

      await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '1', addBlocks: ['2'] })
        .execute(createAbortSignal());
      await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '2', addBlockedBy: ['1'] })
        .execute(createAbortSignal());

      const listResult = await getTool('session-a', configDir, 'TaskList')
        .build({})
        .execute(createAbortSignal());
      const listContent = listResult.llmContent as {
        tasks: Array<{ id: string; blocks: string[]; blockedBy: string[] }>;
      };
      const firstTask = listContent.tasks.find((task) => task.id === '1');
      const secondTask = listContent.tasks.find((task) => task.id === '2');

      expect(firstTask?.blocks).toEqual(['2']);
      expect(firstTask?.blockedBy).toEqual([]);
      expect(secondTask?.blocks).toEqual([]);
      expect(secondTask?.blockedBy).toEqual(['1']);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('merges task metadata and deletes keys with null values', async () => {
    const configDir = await createTempConfigDir();

    try {
      await getTool('session-a', configDir, 'TaskCreate')
        .build({
          subject: 'Audit metadata',
          description: 'Verify metadata update behavior',
          metadata: { a: 1, b: 2 },
        })
        .execute(createAbortSignal());

      const updateResult = await getTool('session-a', configDir, 'TaskUpdate')
        .build({ taskId: '1', metadata: { b: null, c: 3 } })
        .execute(createAbortSignal());
      const updateContent = updateResult.llmContent as {
        task: { metadata: Record<string, unknown> };
        updatedFields: string[];
      };

      expect(updateContent.updatedFields).toContain('metadata');
      expect(updateContent.task.metadata).toEqual({ a: 1, c: 3 });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent managers without retaining coordination keys', async () => {
    const configDir = await createTempConfigDir();

    try {
      const taskListId = 'same-process-team';
      const tasks = await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          TaskListManager.getInstance(taskListId, configDir).createTask({
            subject: `Concurrent task ${index}`,
            description: 'Created by an independent manager instance',
          })
        )
      );

      expect(tasks.map((task) => Number(task.id)).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 64 }, (_, index) => index + 1)
      );
      await expect(
        TaskListManager.getInstance(taskListId, configDir).listTasks()
      ).resolves.toHaveLength(64);
      expect(TaskListManager.coordinationStatsForTests()).toEqual({
        keys: 0,
        operations: 0,
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('fails closed without overwriting corrupt task-list state', async () => {
    const configDir = await createTempConfigDir();
    const tasksDir = path.join(configDir, 'tasks');
    const filePath = path.join(tasksDir, 'corrupt-list-agent-corrupt-list.json');
    const corruptState = '{"nextId":2,"tasks":[{"id":"1"}]}';

    try {
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(filePath, corruptState, 'utf-8');
      const manager = TaskListManager.getInstance('corrupt-list', configDir);

      await expect(manager.listTasks()).rejects.toThrow(
        'Task list state is corrupt or unreadable'
      );
      await expect(
        manager.createTask({
          subject: 'Must not overwrite',
          description: 'The corrupt state must remain authoritative',
        })
      ).rejects.toThrow('Task list state is corrupt or unreadable');
      await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(corruptState);
      expect(TaskListManager.coordinationStatsForTests()).toEqual({
        keys: 0,
        operations: 0,
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('encodes task-list IDs before deriving a persistence path', async () => {
    const configDir = await createTempConfigDir();

    try {
      await TaskListManager.getInstance('../outside', configDir).createTask({
        subject: 'Contained task',
        description: 'Must stay below the tasks directory',
      });

      const entries = await fs.readdir(path.join(configDir, 'tasks'));
      expect(entries).toEqual(['..%2Foutside-agent-..%2Foutside.json']);
      await expect(
        fs.readFile(path.join(configDir, 'outside-agent-..', 'outside.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('builtin task list tool registration', () => {
  it('uses the unified Blade storage root by default', async () => {
    const storageRoot = await createTempConfigDir();
    const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      const tools = await getBuiltinTools({ sessionId: 'storage-root-session' });
      const taskCreate = tools.find((tool) => tool.name === 'TaskCreate');
      if (!taskCreate) throw new Error('TaskCreate tool not found');

      const result = await taskCreate
        .build({
          subject: 'Unified storage',
          description: 'Persist with the Session runtime state',
        })
        .execute(createAbortSignal());
      expect(result.success).toBe(true);
      await expect(
        fs.readFile(
          path.join(
            storageRoot,
            'tasks',
            'storage-root-session-agent-storage-root-session.json'
          ),
          'utf-8'
        )
      ).resolves.toContain('Unified storage');
    } finally {
      if (previousStorageRoot === undefined) {
        delete process.env.BLADE_STORAGE_ROOT;
      } else {
        process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
      }
      await fs.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('exposes Task list tools without TodoWrite compatibility', async () => {
    const configDir = await createTempConfigDir();

    try {
      const tools = await getBuiltinTools({ sessionId: 'session-a', configDir });
      const names = tools.map((tool) => tool.name);

      expect(names).toEqual(expect.arrayContaining(['TaskCreate', 'TaskGet']));
      expect(names).toEqual(expect.arrayContaining(['TaskUpdate', 'TaskList']));
      expect(names).toEqual(expect.arrayContaining(['EnterWorktree', 'ExitWorktree']));
      expect(names).not.toContain('TodoWrite');

      const task = tools.find((tool) => tool.name === 'Task');
      expect(task?.getFunctionDeclaration().parameters).toMatchObject({
        properties: {
          isolation: {
            enum: ['none', 'worktree'],
          },
        },
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('exports an explicit empty required array for TaskList parameters', async () => {
    const configDir = await createTempConfigDir();

    try {
      const taskListTool = createTaskListTools({
        sessionId: 'session-a',
        configDir,
      }).find((tool) => tool.name === 'TaskList');

      expect(taskListTool).toBeDefined();
      expect(taskListTool?.getFunctionDeclaration().parameters).toMatchObject({
        type: 'object',
        properties: {},
        additionalProperties: false,
        required: [],
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
