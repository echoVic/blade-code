import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createTodoWriteTool } from '../../../../src/tools/builtin/todo/index';
import type { TodoItem } from '../../../../src/tools/builtin/todo/types';

async function createTempConfigDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'blade-todo-test-'));
}

async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function createAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('todo tools persistence', () => {
  it('writes todos into session-scoped files under ~/.blade/todos', async () => {
    const configDir = await createTempConfigDir();
    try {
      const writeTool = createTodoWriteTool({ sessionId: 'session-a', configDir });
      const invocation = writeTool.build({
        todos: [
          {
            content: 'implement feature A',
            status: 'in_progress',
            activeForm: 'implementing feature A',
            priority: 'high',
          },
        ],
      });

      await invocation.execute(createAbortSignal());

      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'todos', 'session-a-agent-session-a.json'),
          'utf-8'
        )
      ) as TodoItem[];

      expect(stored).toHaveLength(1);
      expect(stored[0].content).toBe('implement feature A');
      expect(stored[0].status).toBe('in_progress');
      expect(stored[0].priority).toBe('high');
      expect(stored[0].activeForm).toBe('implementing feature A');

      // 验证自动生成的字段
      expect(stored[0].id).toBeDefined();
      expect(typeof stored[0].id).toBe('string');
      expect(stored[0].createdAt).toBeDefined();
      expect(typeof stored[0].createdAt).toBe('string');
      expect(stored[0].startedAt).toBeDefined(); // 因为状态是in_progress
      expect(typeof stored[0].startedAt).toBe('string');
    } finally {
      await cleanupTempDir(configDir);
    }
  });

  it('isolates todos between different sessions', async () => {
    const configDir = await createTempConfigDir();
    try {
      const writeTool1 = createTodoWriteTool({ sessionId: 'session-1', configDir });
      const writeTool2 = createTodoWriteTool({ sessionId: 'session-2', configDir });

      const todoForSession1 = writeTool1.build({
        todos: [
          {
            content: 'session 1 task',
            status: 'pending',
            activeForm: 'working on session 1 task',
            priority: 'medium',
          },
        ],
      });

      const todoForSession2 = writeTool2.build({
        todos: [
          {
            content: 'session 2 task',
            status: 'pending',
            activeForm: 'working on session 2 task',
            priority: 'low',
          },
        ],
      });

      await todoForSession1.execute(createAbortSignal());
      await todoForSession2.execute(createAbortSignal());

      const session1Data = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'todos', 'session-1-agent-session-1.json'),
          'utf-8'
        )
      ) as TodoItem[];
      const session2Data = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'todos', 'session-2-agent-session-2.json'),
          'utf-8'
        )
      ) as TodoItem[];

      expect(session1Data).toHaveLength(1);
      expect(session2Data).toHaveLength(1);
      expect(session1Data[0].content).toBe('session 1 task');
      expect(session2Data[0].content).toBe('session 2 task');
      expect(session1Data[0].priority).toBe('medium');
      expect(session2Data[0].priority).toBe('low');
      expect(session1Data[0].status).toBe('pending');
      expect(session2Data[0].status).toBe('pending');

      // 验证自动生成的字段
      expect(session1Data[0].id).toBeDefined();
      expect(session2Data[0].id).toBeDefined();
      expect(session1Data[0].createdAt).toBeDefined();
      expect(session2Data[0].createdAt).toBeDefined();
      expect(session1Data[0].startedAt).toBeUndefined(); // 因为状态是pending
      expect(session2Data[0].startedAt).toBeUndefined();
    } finally {
      await cleanupTempDir(configDir);
    }
  });

  it('returns current todos in response after write', async () => {
    const configDir = await createTempConfigDir();
    try {
      const writeTool = createTodoWriteTool({
        sessionId: 'default-session',
        configDir,
      });

      const writeInvocation = writeTool.build({
        todos: [
          {
            content: 'default task',
            status: 'completed',
            activeForm: 'completing default task',
            priority: 'medium',
          },
        ],
      });

      const writeResult = await writeInvocation.execute(createAbortSignal());

      // TodoWrite 返回值包含当前任务列表（无需 TodoRead）
      const llmContent = writeResult.llmContent as { todos: TodoItem[] };
      expect(llmContent.todos).toHaveLength(1);
      expect(llmContent.todos[0].content).toBe('default task');
      expect(llmContent.todos[0].status).toBe('completed');

      // 验证持久化
      const stored = JSON.parse(
        await fs.readFile(
          path.join(configDir, 'todos', 'default-session-agent-default-session.json'),
          'utf-8'
        )
      ) as TodoItem[];

      expect(stored).toHaveLength(1);
      expect(stored[0].content).toBe('default task');
      expect(stored[0].status).toBe('completed');
      expect(stored[0].priority).toBe('medium');

      // 验证自动生成的字段
      expect(stored[0].id).toBeDefined();
      expect(stored[0].createdAt).toBeDefined();
      expect(stored[0].completedAt).toBeDefined(); // 因为状态是completed
    } finally {
      await cleanupTempDir(configDir);
    }
  });
});
