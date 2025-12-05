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
  kind: ToolKind.ReadOnly,

  schema: z.object({
    bash_id: z.string().min(1).describe('Background bash session ID'),
    filter: z
      .string()
      .optional()
      .describe(
        'Optional regex filter: only return matching lines; non-matching lines are discarded'
      ),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Retrieves output from a running or completed background bash shell',
    long: `
- Retrieves output from a running or completed background bash shell
- Takes a shell_id parameter identifying the shell
- Always returns only new output since the last check
- Returns stdout and stderr output along with shell status
- Supports optional regex filtering to show only lines matching a pattern
- Use this tool when you need to monitor or check the output of a long-running shell
- Shell IDs can be found using the /tasks command
`,
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
          llmContent: `Invalid regular expression: ${params.filter}\n\n💡 Output was not consumed; you can retry`,
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
        llmContent: `Bash session not found: ${params.bash_id}`,
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
      finished_at: snapshot.endedAt
        ? new Date(snapshot.endedAt).toISOString()
        : undefined,
      stdout: stdoutLines,
      stderr: stderrLines,
    };

    const displayContent = formatDisplay(
      snapshot,
      stdoutLines.length,
      stderrLines.length
    );

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
