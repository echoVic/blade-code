/**
 * `blade schedule` — manage scheduled tasks from the CLI.
 *
 * The CLI reads/writes the same `~/.blade/schedules.json` that the long-running
 * `blade serve` process watches, so schedules created here are picked up by a
 * running server on its next tick. Without a running server, schedules persist
 * and fire once a server is started.
 */

import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import {
  describeTrigger,
  parseIntervalMs,
  validateTrigger,
} from '../agent/runtime/scheduleTiming.js';
import type { CreateScheduleRequest, ScheduleTrigger } from '../api/schemas.js';
import { scheduleStore } from '../services/ScheduleStore.js';
import { getCwd } from '../utils/cwd.js';

type AnyArgs = ArgumentsCamelCase<Record<string, unknown>>;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Build a trigger from the mutually-exclusive --cron/--every/--at flags. */
function resolveTrigger(argv: AnyArgs): ScheduleTrigger {
  const cron = asString(argv.cron);
  const every = asString(argv.every);
  const at = asString(argv.at);
  const provided = [cron, every, at].filter(Boolean);
  if (provided.length !== 1) {
    throw new Error('Provide exactly one of --cron, --every, or --at');
  }
  if (cron) {
    return { kind: 'cron', cron };
  }
  if (every) {
    const intervalMs = parseIntervalMs(every);
    if (!intervalMs) {
      throw new Error(`Invalid --every value "${every}" (use e.g. 30m, 2h, 1d)`);
    }
    return { kind: 'interval', intervalMs };
  }
  const runAt = new Date(at as string);
  if (Number.isNaN(runAt.getTime())) {
    throw new Error(`Invalid --at value "${at}" (use an ISO timestamp)`);
  }
  return { kind: 'once', runAt: runAt.toISOString() };
}

const scheduleCreateCommand: CommandModule = {
  command: 'create <prompt>',
  describe: '创建定时任务',
  builder: (yargs) =>
    yargs
      .positional('prompt', {
        type: 'string',
        describe: '定时任务运行时发送给 Agent 的提示词',
        demandOption: true,
      })
      .option('cron', { type: 'string', describe: '5 段 cron 表达式（本地时区）' })
      .option('every', { type: 'string', describe: '间隔（如 30m、2h、1d）' })
      .option('at', { type: 'string', describe: '一次性运行的 ISO 时间点' })
      .option('project-path', {
        alias: ['projectPath', 'project'],
        type: 'string',
        describe: '目标项目路径（默认当前目录）',
      })
      .option('title', { type: 'string', describe: '定时任务标题' })
      .option('model', { alias: 'm', type: 'string', describe: '模型 ID' })
      .option('permission-mode', {
        type: 'string',
        choices: ['default', 'autoEdit', 'yolo', 'plan'] as const,
        default: 'default' as const,
        describe: '权限模式',
      })
      .option('isolation', {
        type: 'string',
        choices: ['local', 'worktree'] as const,
        default: 'worktree' as const,
        describe: '执行隔离方式',
      })
      .example([
        ['$0 schedule create "跑测试并汇报失败" --every 1h', '每小时运行一次'],
        [
          '$0 schedule create "生成每日站会摘要" --cron "0 9 * * 1-5"',
          '工作日 9 点运行',
        ],
      ]),
  handler: async (argv: AnyArgs) => {
    try {
      const trigger = resolveTrigger(argv);
      const triggerError = validateTrigger(trigger);
      if (triggerError) throw new Error(triggerError);

      const request: CreateScheduleRequest = {
        prompt: argv.prompt as string,
        projectPath: asString(argv.projectPath) ?? getCwd(),
        title: asString(argv.title),
        trigger,
        modelId: asString(argv.model),
        isolation: (asString(argv.isolation) as 'local' | 'worktree') ?? 'worktree',
        permissionMode: (asString(argv.permissionMode) ??
          'default') as CreateScheduleRequest['permissionMode'],
        enabled: true,
      };
      const schedule = await scheduleStore.create(request);
      console.log(chalk.green(`✓ 已创建定时任务 ${schedule.id}`));
      console.log(`  ${describeTrigger(schedule.trigger)}`);
      console.log(`  项目: ${schedule.projectPath}`);
      console.log(
        `  下次运行: ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '（无）'}`
      );
      process.exit(0);
    } catch (error) {
      console.error(
        chalk.red(`创建定时任务失败: ${error instanceof Error ? error.message : error}`)
      );
      process.exit(1);
    }
  },
};

const scheduleListCommand: CommandModule = {
  command: 'list',
  aliases: ['ls'],
  describe: '列出所有定时任务',
  handler: async () => {
    const schedules = await scheduleStore.list();
    if (schedules.length === 0) {
      console.log(chalk.dim('尚无定时任务。使用 `blade schedule create` 创建。'));
      process.exit(0);
    }
    for (const schedule of schedules) {
      const status = schedule.enabled ? chalk.green('启用') : chalk.dim('停用');
      const next = schedule.nextRunAt
        ? new Date(schedule.nextRunAt).toLocaleString()
        : '—';
      const last = schedule.lastRunAt
        ? `${new Date(schedule.lastRunAt).toLocaleString()} (${schedule.lastStatus ?? '?'})`
        : '从未';
      console.log(
        `${chalk.cyan(schedule.id)} [${status}] ${schedule.title ?? schedule.prompt.slice(0, 40)}`
      );
      console.log(
        `    ${describeTrigger(schedule.trigger)} · 下次: ${next} · 上次: ${last} · 运行 ${schedule.runCount} 次`
      );
      console.log(chalk.dim(`    项目: ${schedule.projectPath}`));
    }
    process.exit(0);
  },
};

const scheduleShowCommand: CommandModule = {
  command: 'show <id>',
  describe: '查看定时任务详情',
  builder: (yargs) =>
    yargs.positional('id', {
      type: 'string',
      describe: '定时任务 ID',
      demandOption: true,
    }),
  handler: async (argv: AnyArgs) => {
    const schedule = await scheduleStore.get(argv.id as string);
    if (!schedule) {
      console.error(chalk.red(`未找到定时任务 ${argv.id}`));
      process.exit(1);
    }
    console.log(JSON.stringify(schedule, null, 2));
    process.exit(0);
  },
};

const scheduleRemoveCommand: CommandModule = {
  command: 'remove <id>',
  aliases: ['rm'],
  describe: '删除定时任务',
  builder: (yargs) =>
    yargs.positional('id', {
      type: 'string',
      describe: '定时任务 ID',
      demandOption: true,
    }),
  handler: async (argv: AnyArgs) => {
    const removed = await scheduleStore.remove(argv.id as string);
    if (!removed) {
      console.error(chalk.red(`未找到定时任务 ${argv.id}`));
      process.exit(1);
    }
    console.log(chalk.green(`✓ 已删除定时任务 ${argv.id}`));
    process.exit(0);
  },
};

const scheduleEnableCommand: CommandModule = {
  command: 'enable <id>',
  describe: '启用定时任务',
  builder: (yargs) =>
    yargs.positional('id', {
      type: 'string',
      describe: '定时任务 ID',
      demandOption: true,
    }),
  handler: async (argv: AnyArgs) => {
    const updated = await scheduleStore.setEnabled(argv.id as string, true);
    if (!updated) {
      console.error(chalk.red(`未找到定时任务 ${argv.id}`));
      process.exit(1);
    }
    console.log(chalk.green(`✓ 已启用定时任务 ${argv.id}`));
    process.exit(0);
  },
};

const scheduleDisableCommand: CommandModule = {
  command: 'disable <id>',
  describe: '停用定时任务',
  builder: (yargs) =>
    yargs.positional('id', {
      type: 'string',
      describe: '定时任务 ID',
      demandOption: true,
    }),
  handler: async (argv: AnyArgs) => {
    const updated = await scheduleStore.setEnabled(argv.id as string, false);
    if (!updated) {
      console.error(chalk.red(`未找到定时任务 ${argv.id}`));
      process.exit(1);
    }
    console.log(chalk.green(`✓ 已停用定时任务 ${argv.id}`));
    process.exit(0);
  },
};

const scheduleRunCommand: CommandModule = {
  command: 'run <id>',
  describe: '立即运行定时任务（需要 blade serve）',
  builder: (yargs) =>
    yargs
      .positional('id', {
        type: 'string',
        describe: '定时任务 ID',
        demandOption: true,
      })
      .option('server', {
        type: 'string',
        default: process.env.BLADE_SERVER_URL ?? 'http://127.0.0.1:4097',
        describe: 'Blade server 地址',
      }),
  handler: async (argv: AnyArgs) => {
    const id = argv.id as string;
    const baseUrl = (asString(argv.server) ?? 'http://127.0.0.1:4097').replace(
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
    try {
      const response = await fetch(
        `${baseUrl}/schedules/${encodeURIComponent(id)}/run`,
        { method: 'POST', headers }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        throw new Error(
          body?.error?.message ?? `Schedule run failed (${response.status})`
        );
      }
      console.log(chalk.green(`✓ 已触发定时任务 ${id}`));
      process.exit(0);
    } catch (error) {
      console.error(
        chalk.red(`运行定时任务失败: ${error instanceof Error ? error.message : error}`)
      );
      process.exit(1);
    }
  },
};

export const scheduleCommands: CommandModule = {
  command: 'schedule',
  describe: '管理定时任务',
  builder: (yargs) =>
    yargs
      .command(scheduleCreateCommand)
      .command(scheduleListCommand)
      .command(scheduleShowCommand)
      .command(scheduleRemoveCommand)
      .command(scheduleEnableCommand)
      .command(scheduleDisableCommand)
      .command(scheduleRunCommand)
      .demandCommand(
        1,
        '请提供子命令：create | list | show | remove | enable | disable | run'
      ),
  handler: () => {
    // Subcommands handle everything; demandCommand shows usage otherwise.
  },
};
