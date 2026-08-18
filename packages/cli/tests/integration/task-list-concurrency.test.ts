import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskListManager } from '../../src/tools/builtin/task/TaskListManager.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);
const fixture = path.resolve(import.meta.dirname, '../fixtures/task-list-process.ts');
const bunExecutable = process.env.BUN_EXEC_PATH ?? 'bun';

describe('durable task-list cross-process coordination', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'blade-task-list-process-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('preserves every unique ID across concurrent writer processes', async () => {
    const taskListId = 'shared-process-list';
    const processCount = 6;
    const tasksPerProcess = 8;

    await Promise.all(
      Array.from({ length: processCount }, (_, index) =>
        execFileAsync(
          bunExecutable,
          [
            fixture,
            'create',
            configDir,
            taskListId,
            String(tasksPerProcess),
            `writer-${index}`,
          ],
          { timeout: 20_000 }
        )
      )
    );

    const tasks = await TaskListManager.getInstance(taskListId, configDir).listTasks();
    const expectedCount = processCount * tasksPerProcess;
    expect(tasks).toHaveLength(expectedCount);
    expect(tasks.map((task) => Number(task.id)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: expectedCount }, (_, index) => index + 1)
    );
    expect(new Set(tasks.map((task) => task.subject)).size).toBe(expectedCount);

    const stored = JSON.parse(
      await readFile(
        path.join(configDir, 'tasks', `${taskListId}-agent-${taskListId}.json`),
        'utf-8'
      )
    ) as { nextId: number };
    expect(stored.nextId).toBe(expectedCount + 1);
  }, 30_000);

  it('reclaims a file lock after its owning process is killed', async () => {
    const taskListId = 'crashed-process-list';
    const holder = spawn(bunExecutable, [fixture, 'hold-lock', configDir, taskListId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    await waitForOutput(holder, 'LOCKED');

    holder.kill('SIGKILL');
    await waitForExit(holder);

    const task = await TaskListManager.getInstance(taskListId, configDir).createTask({
      subject: 'Recovered write',
      description: 'Write after lock-owner crash',
    });
    expect(task.id).toBe('1');
    await expect(
      readFile(
        path.join(configDir, 'tasks', `${taskListId}-agent-${taskListId}.json`),
        'utf-8'
      )
    ).resolves.toContain('Recovered write');
  });
});

function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child output: ${marker}`));
    }, 10_000);

    if (!child.stdout) {
      clearTimeout(timeout);
      reject(new Error('Child stdout is not piped'));
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!stdout.includes(marker)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Child exited before ${marker}: code=${String(code)} signal=${String(signal)}`
          )
        );
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}
