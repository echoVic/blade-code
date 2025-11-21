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

    // 🔴 关键修复：先校验正则表达式,再消费输出
    // 避免正则非法时已经清空缓冲区,导致数据丢失
    let regex: RegExp | undefined;
    if (params.filter) {
      try {
        regex = new RegExp(params.filter);
      } catch (error: unknown) {
        return {
          success: false,
          llmContent: `无效的正则表达式: ${params.filter}\n\n💡 输出未被消费,可重新尝试`,
          displayContent: `❌ 无效的正则表达式: ${params.filter}\n\n💡 输出未被消费,可重新尝试`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: (error as Error).message,
          },
        };
      }
    }

    // 校验通过后,再消费输出
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

  /**
   * 提取签名内容：返回 bash ID
   * 用于显示和权限签名构建
   */
  extractSignatureContent: (params) => params.bash_id,

  /**
   * 抽象权限规则：返回通配符格式(只读工具通常自动批准)
   */
  abstractPermissionRule: () => '*',
});

function applyFilter(snapshot: ShellOutputSnapshot, regex?: RegExp) {
  // 🔴 关键修复：重置 lastIndex 防止全局标志污染
  // 如果正则包含 g 或 y 标志，多次 test() 会推进 lastIndex，导致后续行被跳过
  const stdoutLines = splitLines(snapshot.stdout).filter((line) => {
    if (!regex) return true;
    regex.lastIndex = 0; // 每次测试前重置
    return regex.test(line);
  });
  const stderrLines = splitLines(snapshot.stderr).filter((line) => {
    if (!regex) return true;
    regex.lastIndex = 0; // 每次测试前重置
    return regex.test(line);
  });

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
