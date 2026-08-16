import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('weighted task admission source gate', () => {
  it('keeps count and retained bytes independently hard-bounded', () => {
    const config = source('../../src/config/taskConcurrency.ts');
    const scheduler = source('../../src/agent/runtime/TaskRunScheduler.ts');
    const combined = `${config}\n${scheduler}`;

    expect(config).toContain('DEFAULT_MAX_QUEUED_TASK_BYTES = 64 * 1024 * 1024');
    expect(config).toContain('MIN_MAX_QUEUED_TASK_BYTES = 64 * 1024');
    expect(config).toContain(
      'MAX_MAX_QUEUED_TASK_BYTES = 128 * 1024 * 1024'
    );
    expect(scheduler).toContain('this.pendingBytes += pending.pendingBytes');
    expect(scheduler).toContain('this.pendingBytes -= pending.pendingBytes');
    expect(scheduler).toContain("'pending_count'");
    expect(scheduler).toContain("'pending_bytes'");
    expect(combined).not.toMatch(/\bInfinity\b/);
    expect(combined).not.toMatch(/NODE_ENV\s*===\s*['"]test['"]/);
    expect(combined).not.toMatch(/BLADE_TEST/);
  });

  it('rejects byte overflow before retaining queue or listener state', () => {
    const scheduler = source('../../src/agent/runtime/TaskRunScheduler.ts');
    const admit = between(
      scheduler,
      'admit(options: TaskAdmissionOptions)',
      '\n  configure('
    );
    const byteRejection = admit.indexOf(
      "new TaskAdmissionQueueFullError('pending_bytes'"
    );

    expect(byteRejection).toBeGreaterThanOrEqual(0);
    expect(byteRejection).toBeLessThan(admit.indexOf('new Promise<TaskRunPermit>'));
    expect(byteRejection).toBeLessThan(admit.indexOf('addEventListener'));
    expect(byteRejection).toBeLessThan(admit.indexOf('this.activeKeys.add'));
    expect(byteRejection).toBeLessThan(admit.indexOf('this.queue.push'));
  });

  it('stores only numeric weight inside scheduler queue records', () => {
    const scheduler = source('../../src/agent/runtime/TaskRunScheduler.ts');
    const pending = between(
      scheduler,
      'interface PendingAdmission',
      '\n}\n\nexport class TaskAdmissionQueueFullError'
    );

    expect(pending).toContain('pendingBytes: number');
    for (const forbidden of [
      'content',
      'prompt',
      'attachment',
      'outputSchema',
      'metadata',
      'SessionRuntime',
      'UserMessageContent',
    ]) {
      expect(pending).not.toContain(forbidden);
    }
  });

  it('weights direct, prepared, and recovered task entry paths', () => {
    const agent = source('../../src/agent/Agent.ts');
    const server = source('../../src/server/routes/session.ts');
    const combined = `${agent}\n${server}`;

    expect(combined.match(/taskRunScheduler\.admit\(\{/g)).toHaveLength(2);
    expect(combined.match(/pendingBytes: estimateTaskRunPendingBytes\(\{/g)).toHaveLength(
      2
    );
    expect(combined.match(/pendingMessages: runtime\.getPendingSteeringMessages\(\)/g))
      .toHaveLength(2);
    expect(agent).toContain('content: message');
    expect(server).toContain('content,');
  });

  it('keeps task byte accounting private from capacity surfaces', () => {
    const globalRoute = source('../../src/server/routes/global.ts');
    const taskStatus = between(
      source('../../src/agent/runtime/SessionRuntime.ts'),
      'async setTaskAdmission(',
      '\n  publishTaskAdmissionCapacity'
    );
    const acp = between(
      source('../../src/acp/Session.ts'),
      "if (event.type !== 'task.status') return;",
      '\n    const activeGoal'
    );
    const combined = `${globalRoute}\n${taskStatus}\n${acp}`;

    expect(globalRoute).toContain('maxQueued: taskAdmission.maxQueued');
    expect(globalRoute).not.toContain('pendingBytes: taskAdmission.pendingBytes');
    expect(globalRoute).not.toContain('maxQueuedBytes: taskAdmission.maxQueuedBytes');
    expect(taskStatus).not.toContain('pendingBytes');
    expect(taskStatus).not.toContain('maxQueuedBytes');
    expect(acp).not.toContain('pendingBytes');
    expect(acp).not.toContain('maxQueuedBytes');
    expect(combined).not.toContain('taskRunWeight');
  });
});
