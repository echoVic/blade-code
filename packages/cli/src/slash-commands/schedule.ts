/**
 * /schedule command — manage scheduled tasks from any surface (TUI, ACP).
 *
 * Reads/writes the same `~/.blade/schedules.json` the `blade serve` scheduler
 * watches, so schedules created here fire from a running server. Output uses
 * the surface-neutral `getUI` bridge so IDEs (ACP) and the TUI both see it.
 *
 * Subcommands:
 *   /schedule                 - list schedules (default)
 *   /schedule list
 *   /schedule create <cron|every|at> <spec> -- <prompt>
 *   /schedule remove <id>
 *   /schedule enable <id>
 *   /schedule disable <id>
 */

import {
  describeTrigger,
  parseIntervalMs,
  validateTrigger,
} from '../agent/runtime/scheduleTiming.js';
import type { CreateScheduleRequest, ScheduleTrigger } from '../api/schemas.js';
import { type ScheduleStore, scheduleStore } from '../services/ScheduleStore.js';
import { getUI, type SlashCommand, type SlashCommandResult } from './types.js';

/**
 * Parse `create` args: a trigger flag/value followed by the prompt.
 * Accepts:  `cron "0 9 * * *" review the PR`
 *           `every 1h run the tests`
 *           `at 2026-08-12T09:00 summarize`
 * Also tolerates a leading `--` separator before the prompt.
 */
export function parseScheduleCreateArgs(
  args: string[]
): { trigger: ScheduleTrigger; prompt: string } | { error: string } {
  if (args.length < 2) {
    return { error: 'Usage: /schedule create <cron|every|at> <spec> <prompt>' };
  }
  const kind = args[0].toLowerCase();
  let spec: string;
  let promptTokens: string[];
  if (kind === 'cron') {
    const separator = args.indexOf('--');
    if (separator > 1) {
      spec = args.slice(1, separator).join(' ');
      promptTokens = args.slice(separator + 1);
    } else {
      if (args.length < 7) {
        return {
          error:
            'Usage: /schedule create cron <min> <hour> <dom> <mon> <dow> -- <prompt>',
        };
      }
      spec = args.slice(1, 6).join(' ');
      promptTokens = args.slice(6);
    }
    spec = spec.replace(/^["']|["']$/g, '');
  } else {
    spec = args[1];
    promptTokens = args.slice(2);
  }
  if (promptTokens[0] === '--') promptTokens = promptTokens.slice(1);
  const prompt = promptTokens.join(' ').trim();
  if (!prompt) return { error: 'A prompt is required' };

  let trigger: ScheduleTrigger;
  switch (kind) {
    case 'cron':
      trigger = { kind: 'cron', cron: spec };
      break;
    case 'every': {
      const intervalMs = parseIntervalMs(spec);
      if (!intervalMs) return { error: `Invalid interval "${spec}" (use 30m, 2h, 1d)` };
      trigger = { kind: 'interval', intervalMs };
      break;
    }
    case 'at': {
      const runAt = new Date(spec);
      if (Number.isNaN(runAt.getTime())) {
        return { error: `Invalid timestamp "${spec}" (use an ISO date)` };
      }
      trigger = { kind: 'once', runAt: runAt.toISOString() };
      break;
    }
    default:
      return { error: `Unknown trigger "${kind}" (use cron | every | at)` };
  }
  const triggerError = validateTrigger(trigger);
  if (triggerError) return { error: triggerError };
  return { trigger, prompt };
}

async function runScheduleViaServer(id: string): Promise<void> {
  const baseUrl = (process.env.BLADE_SERVER_URL ?? 'http://127.0.0.1:4097').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {};
  if (process.env.BLADE_SERVER_PASSWORD) {
    const username = process.env.BLADE_SERVER_USERNAME ?? 'blade';
    headers.Authorization = `Basic ${Buffer.from(
      `${username}:${process.env.BLADE_SERVER_PASSWORD}`
    ).toString('base64')}`;
  }
  const response = await fetch(`${baseUrl}/schedules/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    throw new Error(body?.error?.message ?? `Schedule run failed (${response.status})`);
  }
}

export function createScheduleSlashCommand(
  store: ScheduleStore = scheduleStore
): SlashCommand {
  return {
    name: 'schedule',
    description: 'Manage scheduled tasks',
    fullDescription: `管理定时任务（在 blade serve 运行时按计划触发）。

子命令：
  /schedule                              - 列出所有定时任务
  /schedule list                         - 列出所有定时任务
  /schedule create every 1h 跑测试并汇报   - 每小时运行
  /schedule create cron "0 9 * * 1-5" 站会 - 工作日 9 点运行
  /schedule create at 2026-08-12T09:00 汇总 - 指定时间运行一次
  /schedule remove <id>                  - 删除定时任务
  /schedule enable <id>                  - 启用定时任务
  /schedule disable <id>                 - 停用定时任务
  /schedule run <id>                     - 立即运行（需要 blade serve）`,
    usage: '/schedule [list|create|remove|enable|disable|run] ...',
    category: 'system',
    examples: [
      '/schedule',
      '/schedule create every 1h run the test suite and report failures',
      '/schedule create cron 0 9 * * 1-5 -- summarize open PRs',
      '/schedule run abc123',
    ],

    handler: async (args, context): Promise<SlashCommandResult> => {
      const ui = getUI(context);
      const subcommand = args[0]?.toLowerCase() || 'list';
      const rest = args.slice(1);
      const projectPath = context.workspaceRoot ?? context.cwd;

      switch (subcommand) {
        case 'list':
        case '': {
          const schedules = await store.list();
          if (schedules.length === 0) {
            ui.sendMessage('没有定时任务。用 `/schedule create` 创建一个。');
            return { success: true, message: 'No schedules' };
          }
          const lines = ['## 定时任务', ''];
          for (const schedule of schedules) {
            const status = schedule.enabled ? '启用' : '停用';
            const next = schedule.nextRunAt
              ? new Date(schedule.nextRunAt).toLocaleString()
              : '—';
            lines.push(
              `- \`${schedule.id}\` [${status}] ${schedule.title ?? schedule.prompt.slice(0, 40)}`
            );
            lines.push(`  ${describeTrigger(schedule.trigger)} · 下次: ${next}`);
          }
          ui.sendMessage(lines.join('\n'));
          return {
            success: true,
            message: 'Schedules listed',
            content: lines.join('\n'),
          };
        }

        case 'create': {
          const parsed = parseScheduleCreateArgs(rest);
          if ('error' in parsed) {
            ui.sendMessage(`创建失败：${parsed.error}`);
            return { success: false, error: parsed.error };
          }
          const request: CreateScheduleRequest = {
            prompt: parsed.prompt,
            projectPath,
            trigger: parsed.trigger,
            isolation: 'worktree',
            permissionMode: 'default',
            enabled: true,
          };
          try {
            const schedule = await store.create(request);
            const next = schedule.nextRunAt
              ? new Date(schedule.nextRunAt).toLocaleString()
              : '（无）';
            ui.sendMessage(
              `[OK] 已创建定时任务 \`${schedule.id}\`\n${describeTrigger(schedule.trigger)} · 下次运行: ${next}`
            );
            return { success: true, message: `Schedule ${schedule.id} created` };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ui.sendMessage(`创建失败：${message}`);
            return { success: false, error: message };
          }
        }

        case 'remove':
        case 'rm': {
          const id = rest[0];
          if (!id) {
            ui.sendMessage('用法：/schedule remove <id>');
            return { success: false, error: 'Missing schedule id' };
          }
          const removed = await store.remove(id);
          ui.sendMessage(removed ? `[OK] 已删除 \`${id}\`` : `未找到 \`${id}\``);
          return { success: removed, message: removed ? 'Removed' : 'Not found' };
        }

        case 'enable':
        case 'disable': {
          const id = rest[0];
          if (!id) {
            ui.sendMessage(`用法：/schedule ${subcommand} <id>`);
            return { success: false, error: 'Missing schedule id' };
          }
          const updated = await store.setEnabled(id, subcommand === 'enable');
          ui.sendMessage(
            updated
              ? `[OK] 已${subcommand === 'enable' ? '启用' : '停用'} \`${id}\``
              : `未找到 \`${id}\``
          );
          return {
            success: Boolean(updated),
            message: updated ? 'Updated' : 'Not found',
          };
        }

        case 'run': {
          const id = rest[0];
          if (!id) {
            ui.sendMessage('用法：/schedule run <id>');
            return { success: false, error: 'Missing schedule id' };
          }
          try {
            await runScheduleViaServer(id);
            ui.sendMessage(`[OK] 已触发 \`${id}\``);
            return { success: true, message: 'Schedule triggered' };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ui.sendMessage(`运行失败：${message}`);
            return { success: false, error: message };
          }
        }

        default: {
          ui.sendMessage(`未知子命令: ${subcommand}\n使用 /schedule 查看帮助`);
          return { success: false, error: `Unknown subcommand: ${subcommand}` };
        }
      }
    },
  };
}

export default createScheduleSlashCommand();
