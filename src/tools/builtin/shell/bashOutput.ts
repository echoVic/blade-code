import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import {
  BackgroundShellManager,
  type ShellOutputSnapshot,
} from './BackgroundShellManager.js';

export const bashOutputTool = createTool({
  name: 'BashOutput',
  displayName: '后台命令输出',
  kind: ToolKind.Execute,
  isReadOnly: true,

  schema: z.object({
    bash_id: z.string().min(1).describe('后台 bash 会话 ID'),
    filter: z
      .string()
      .optional()
      .describe('可选正则过滤，只返回匹配的输出行，不匹配的会被丢弃'),
  }),

  description: {
    short: '获取后台 bash 命令的最新输出',
    long: `检索正在运行或已完成的后台 bash 命令的增量输出，仅返回自上次读取以来的新 stdout/stderr 内容。`,
    usageNotes: [
      'Always returns only new output since the last check',
      'Supports optional regex filtering via filter 参数',
      'Lines that do not match the filter are discarded and不可再次读取',
      '返回 stdout/stderr 分开且附带进程状态',
      'Shell IDs 可通过 Bash 工具返回值或 /bashes 命令查看',
    ],
    examples: [
      {
        description: '查看后台命令输出',
        params: {
          bash_id: 'bash_123456',
        },
      },
      {
        description: '仅查看包含 ERROR 的行',
        params: {
          bash_id: 'bash_123456',
          filter: 'ERROR',
        },
      },
    ],
    important: [
      'Use this tool when you need to monitor or check the output of a long-running shell',
      'Regex 需要符合 JavaScript 语法，非法表达式会报错',
      '如果后台命令已经退出，status 会返回 exited/killed/error',
    ],
  },

  async execute(params, _context: ExecutionContext): Promise<ToolResult> {
    const manager = BackgroundShellManager.getInstance();
    const snapshot = manager.consumeOutput(params.bash_id);

    if (!snapshot) {
      return {
        success: false,
        llmContent: `未找到 Bash 会话: ${params.bash_id}`,
        displayContent: `❌ 未找到 Bash 会话: ${params.bash_id}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Bash 会话不存在或已清理',
        },
      };
    }

    let regex: RegExp | undefined;
    if (params.filter) {
      try {
        regex = new RegExp(params.filter);
      } catch (error: unknown) {
        return {
          success: false,
          llmContent: `无效的正则表达式: ${params.filter}`,
          displayContent: `❌ 无效的正则表达式: ${params.filter}`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: (error as Error).message,
          },
        };
      }
    }

    const { stdoutLines, stderrLines } = applyFilter(snapshot, regex);

    const payload = {
      bash_id: snapshot.id,
      status: snapshot.status,
      command: snapshot.command,
      pid: snapshot.pid,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      started_at: new Date(snapshot.startedAt).toISOString(),
      finished_at: snapshot.endedAt ? new Date(snapshot.endedAt).toISOString() : undefined,
      stdout: stdoutLines,
      stderr: stderrLines,
    };

    const displayContent = formatDisplay(snapshot, stdoutLines.length, stderrLines.length);

    return {
      success: true,
      llmContent: payload,
      displayContent,
      metadata: payload,
    };
  },

  version: '1.0.0',
  category: '命令工具',
  tags: ['bash', 'shell', 'monitor'],

  extractSignatureContent: (params) => `bash:${params.bash_id}`,
  abstractPermissionRule: () => 'bash:output',
});

function applyFilter(snapshot: ShellOutputSnapshot, regex?: RegExp) {
  const stdoutLines = splitLines(snapshot.stdout).filter((line) =>
    regex ? regex.test(line) : true
  );
  const stderrLines = splitLines(snapshot.stderr).filter((line) =>
    regex ? regex.test(line) : true
  );

  return {
    stdoutLines,
    stderrLines,
  };
}

function splitLines(output: string): string[] {
  if (!output) {
    return [];
  }
  return output.replace(/\r\n/g, '\n').split('\n');
}

function formatDisplay(
  snapshot: ShellOutputSnapshot,
  stdoutCount: number,
  stderrCount: number
): string {
  const statusEmoji =
    snapshot.status === 'running'
      ? '⏳'
      : snapshot.status === 'exited'
        ? '✅'
        : snapshot.status === 'killed'
          ? '✂️'
          : '⚠️';

  let message = `${statusEmoji} BashOutput(${snapshot.id}) - 状态: ${snapshot.status}`;
  message += `\n命令: ${snapshot.command}`;
  if (snapshot.pid) {
    message += `\nPID: ${snapshot.pid}`;
  }
  if (snapshot.exitCode !== undefined && snapshot.exitCode !== null) {
    message += `\n退出码: ${snapshot.exitCode}`;
  }
  if (snapshot.signal) {
    message += `\n信号: ${snapshot.signal}`;
  }
  if (stdoutCount === 0 && stderrCount === 0) {
    message += `\n无新的输出`;
  } else {
    message += `\nstdout 行数: ${stdoutCount}`;
    message += `\nstderr 行数: ${stderrCount}`;
  }
  return message;
}
