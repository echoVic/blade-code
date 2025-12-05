import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { BackgroundShellManager } from './BackgroundShellManager.js';

export const killShellTool = createTool({
  name: 'KillShell',
  displayName: '终止后台 Shell',
  kind: ToolKind.Execute,

  schema: z.object({
    shell_id: z.string().min(1).describe('Background Shell ID to terminate'),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Kills a running background bash shell by its ID',
    long: `
- Kills a running background bash shell by its ID
- Takes a shell_id parameter identifying the shell to kill
- Returns a success or failure status
- Use this tool when you need to terminate a long-running shell
- Shell IDs can be found using the /tasks command
`,
  },

  async execute(params, _context: ExecutionContext): Promise<ToolResult> {
    const manager = BackgroundShellManager.getInstance();
    const result = manager.kill(params.shell_id);

    if (!result) {
      return {
        success: false,
        llmContent: `Shell not found: ${params.shell_id}`,
        displayContent: `❌ 未找到 Shell: ${params.shell_id}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Shell ID 不存在或已清理',
        },
      };
    }

    if (!result.success && !result.alreadyExited) {
      return {
        success: false,
        llmContent: `Failed to terminate Shell: ${params.shell_id}`,
        displayContent: `❌ 无法终止 Shell (${params.shell_id})`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: '发送终止信号失败',
        },
        metadata: result,
      };
    }

    const statusText = result.alreadyExited
      ? `Shell ${params.shell_id} 已经处于 ${result.status} 状态`
      : `已向 Shell ${params.shell_id} 发送终止信号`;

    return {
      success: true,
      llmContent: {
        shell_id: params.shell_id,
        status: result.status,
        already_exited: result.alreadyExited,
        pid: result.pid,
        exit_code: result.exitCode,
        signal: result.signal,
      },
      displayContent: result.alreadyExited ? `ℹ️ ${statusText}` : `✂️ ${statusText}`,
      metadata: result,
    };
  },

  version: '1.0.0',
  category: '命令工具',
  tags: ['bash', 'shell', 'terminate'],

  /**
   * 提取签名内容：返回 shell ID
   * 用于显示和权限签名构建
   */
  extractSignatureContent: (params) => params.shell_id,

  /**
   * 抽象权限规则：返回通配符格式
   */
  abstractPermissionRule: () => '*',
});
