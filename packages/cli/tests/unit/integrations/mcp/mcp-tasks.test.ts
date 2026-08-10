import type { Task } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  MAX_MCP_TASK_POLL_INTERVAL_MS,
  normalizeMcpServerTask,
  normalizeMcpTaskPolicy,
  normalizeMcpTaskTtl,
  sanitizeMcpTaskError,
} from '../../../../src/mcp/McpTasks.js';

describe('MCP Tasks policy and projection', () => {
  it('is disabled by default and validates bounded opt-in settings', () => {
    expect(normalizeMcpTaskPolicy(undefined)).toMatchObject({
      enabled: false,
      maxTasksPerSession: 32,
    });
    expect(
      normalizeMcpTaskPolicy({
        enabled: true,
        defaultTtlMs: 60_000,
        pollIntervalMs: 250,
        maxTasksPerSession: 8,
        maxLifetimeMs: 120_000,
      })
    ).toEqual({
      enabled: true,
      defaultTtlMs: 60_000,
      pollIntervalMs: 250,
      maxTasksPerSession: 8,
      maxLifetimeMs: 120_000,
    });
    expect(() =>
      normalizeMcpTaskPolicy({
        enabled: true,
        defaultTtlMs: 120_000,
        maxLifetimeMs: 60_000,
      })
    ).toThrow('must not exceed');
  });

  it('normalizes server status text and clamps hostile polling intervals', () => {
    const policy = normalizeMcpTaskPolicy({
      enabled: true,
      maxLifetimeMs: 600_000,
    });
    const state = normalizeMcpServerTask(
      {
        taskId: 'server-task-1',
        status: 'working',
        ttl: 60_000,
        createdAt: '2026-08-08T00:00:00.000Z',
        lastUpdatedAt: '2026-08-08T00:00:01.000Z',
        pollInterval: Number.MAX_SAFE_INTEGER,
        statusMessage: 'ＷＯＲＫ\u200bING\u202e server_task_id=server-task-1',
      },
      policy
    );

    expect(state.pollIntervalMs).toBe(MAX_MCP_TASK_POLL_INTERVAL_MS);
    expect(state.statusMessage).toBe('WORKING server_task_id=[redacted-task-id]');
  });

  it('fails closed when task identity changes across a generation', () => {
    const policy = normalizeMcpTaskPolicy({ enabled: true });
    const task: Task = {
      taskId: 'server-task-2',
      status: 'completed',
      ttl: null,
      createdAt: '2026-08-08T00:00:00.000Z',
      lastUpdatedAt: '2026-08-08T00:00:01.000Z',
    };

    expect(() =>
      normalizeMcpServerTask(task, policy, {
        taskId: 'server-task-2',
        createdAt: '2026-08-08T00:00:02.000Z',
      })
    ).toThrow('identity changed');
  });

  it('bounds requested TTL and redacts lifecycle errors', () => {
    const policy = normalizeMcpTaskPolicy({
      enabled: true,
      defaultTtlMs: 60_000,
      maxLifetimeMs: 120_000,
    });
    expect(normalizeMcpTaskTtl(undefined, policy)).toBe(60_000);
    expect(() => normalizeMcpTaskTtl(180_000, policy)).toThrow();
    expect(
      sanitizeMcpTaskError(
        'Bearer raw-secret https://private.example/path sk-1234567890abcdef'
      )
    ).toBe('Bearer [redacted] [redacted-url] [redacted]');
  });
});
