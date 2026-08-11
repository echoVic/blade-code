import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleStore } from '../../../../../src/services/ScheduleStore.js';
import { getRegisteredCommands } from '../../../../../src/slash-commands/index.js';
import {
  createScheduleSlashCommand,
  parseScheduleCreateArgs,
} from '../../../../../src/slash-commands/schedule.js';

describe('/schedule command', () => {
  let root: string;
  let store: ScheduleStore;
  const messages: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'blade-schedule-command-'));
    store = new ScheduleStore(path.join(root, 'schedules.json'));
    messages.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  const context = () => ({
    cwd: '/tmp/project',
    workspaceRoot: '/tmp/project',
    surface: 'acp' as const,
    acp: {
      sendMessage: (text: string) => messages.push(text),
    },
  });

  it('parses standard five-field cron expressions after slash tokenization', () => {
    expect(
      parseScheduleCreateArgs([
        'cron',
        '0',
        '9',
        '*',
        '*',
        '1-5',
        '--',
        'summarize',
        'PRs',
      ])
    ).toEqual({
      trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
      prompt: 'summarize PRs',
    });
    expect(parseScheduleCreateArgs(['every', '30m', 'run', 'tests'])).toEqual({
      trigger: { kind: 'interval', intervalMs: 1_800_000 },
      prompt: 'run tests',
    });
  });

  it('creates, lists, disables, and removes schedules over the ACP UI bridge', async () => {
    const command = createScheduleSlashCommand(store);
    await command.handler(['create', 'every', '1h', 'run', 'tests'], context());
    const [created] = await store.list();
    expect(created).toMatchObject({
      prompt: 'run tests',
      projectPath: '/tmp/project',
      enabled: true,
    });
    expect(messages.join('')).toContain('已创建定时任务');

    messages.length = 0;
    await command.handler(['list'], context());
    expect(messages.join('')).toContain(created.id);

    await command.handler(['disable', created.id], context());
    expect((await store.get(created.id))?.enabled).toBe(false);

    await command.handler(['remove', created.id], context());
    expect(await store.get(created.id)).toBeUndefined();
  });

  it('runs a schedule through the long-running server endpoint', async () => {
    const command = createScheduleSlashCommand(store);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'schedule-1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const result = await command.handler(['run', 'schedule-1'], context());
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4097/schedules/schedule-1/run',
      expect.objectContaining({ method: 'POST' })
    );
    expect(messages.join('')).toContain('已触发');
  });

  it('is advertised through the command registry consumed by ACP sessions', () => {
    expect(
      getRegisteredCommands('/tmp/project').some(
        (command) => command.name === 'schedule'
      )
    ).toBe(true);
  });
});
