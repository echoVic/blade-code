import { Mutex } from 'async-mutex';
import {
  classifyBrowserHostname,
  normalizeBrowserUrl,
} from '../../browser/BrowserSecurity.js';
import { getConfigService } from '../../config/ConfigService.js';
import {
  PermissionChecker,
  type ToolInvocationDescriptor,
} from '../../config/PermissionChecker.js';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getCwd } from '../../utils/cwd.js';
import type {
  ExecutionContext,
  PermissionDecision,
  Tool,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType } from '../types/index.js';
import type { SessionApprovalStore } from './SessionApprovalStore.js';
import { createRejectedResult } from './ToolExecutionResults.js';

const logger = createLogger(LogCategory.EXECUTION);

export class ToolApprovalController {
  private readonly approvalMutex = new Mutex();

  constructor(
    private readonly sessionApprovals: SessionApprovalStore,
    private readonly permissionChecker: PermissionChecker
  ) {}

  async confirmIfNeeded(
    tool: Tool,
    invocation: ToolInvocation<unknown>,
    params: Record<string, unknown>,
    decision: PermissionDecision,
    permissionSignature: string,
    context: ExecutionContext
  ): Promise<ToolResult | undefined> {
    if (decision.behavior !== 'ask') {
      return undefined;
    }

    return this.approvalMutex.runExclusive(async () => {
      if (context.signal?.aborted) {
        return createRejectedResult('任务已被用户中止', {
          shouldExitLoop: true,
          llmContent: '任务已被用户中止',
          summary: '任务已被用户中止',
          abortedBeforeLaunch: true,
        });
      }
      if (this.sessionApprovals.has(permissionSignature)) {
        return undefined;
      }

      try {
        const hookRejection = await this.runPermissionRequestHook(
          tool,
          params,
          context
        );
        if (hookRejection === 'approved') {
          return undefined;
        }
        if (hookRejection) {
          return hookRejection;
        }

        const details = {
          type: 'permission' as const,
          title: tool.extractSignatureContent
            ? tool.extractSignatureContent(params)
            : tool.name,
          toolName: tool.name,
          args: params,
          message: decision.reason || '此操作需要用户确认',
          kind: tool.kind,
          details: generatePreviewForTool(tool.name, params),
          risks: extractRisks(tool.name, params),
          affectedFiles: invocation.getAffectedPaths() || [],
        };

        logger.warn(`工具 "${tool.name}" 需要用户确认: ${details.title}`);
        const confirmationHandler = context.confirmationHandler;
        if (!confirmationHandler) {
          const permissionMode = context.permissionMode || PermissionMode.DEFAULT;
          if (permissionMode === PermissionMode.YOLO) {
            logger.warn('[WARN] No ConfirmationHandler; auto-approving in YOLO mode');
            return undefined;
          }

          return createRejectedResult(
            `Non-interactive mode with "${permissionMode}" permission: tool "${tool.name}" requires user confirmation but no interactive handler is available. Use --permission-mode yolo to allow all operations.`,
            {
              llmContent: `工具 "${tool.name}" 需要用户确认，但当前为非交互模式且权限模式为 "${permissionMode}"。请使用 --permission-mode yolo 来允许所有操作。`,
              summary: '非交互模式下拒绝需要确认的操作',
              errorType: ToolErrorType.PERMISSION_DENIED,
            }
          );
        }

        const response = context.signal
          ? await confirmationHandler.requestConfirmation(details, context.signal)
          : await confirmationHandler.requestConfirmation(details);
        if (context.signal?.aborted) {
          return createRejectedResult('任务已被用户中止', {
            shouldExitLoop: true,
            llmContent: '任务已被用户中止',
            summary: '任务已被用户中止',
            abortedBeforeLaunch: true,
          });
        }
        if (!response.approved) {
          if (response.scope === 'project') {
            await this.persistProjectPermission(
              tool,
              invocation,
              params,
              'deny',
              context.workspaceRoot || getCwd()
            );
          }
          return createRejectedResult(response.reason || '用户拒绝授权', {
            shouldExitLoop: true,
            llmContent: '已取消工具执行',
            summary: '已取消工具执行',
            errorType: ToolErrorType.PERMISSION_DENIED,
          });
        }

        if (response.scope === 'session') {
          this.sessionApprovals.add(permissionSignature);
        } else if (response.scope === 'project') {
          await this.persistProjectPermission(
            tool,
            invocation,
            params,
            'allow',
            context.workspaceRoot || getCwd()
          );
        }

        return undefined;
      } catch (error) {
        return createRejectedResult(
          `User confirmation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
  }

  private async runPermissionRequestHook(
    tool: Tool,
    params: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<'approved' | ToolResult | undefined> {
    const hookManager = HookManager.getInstance();
    const projectDir = context.workspaceRoot || getCwd();
    const sessionId = context.sessionId || 'unknown';
    if (!hookManager.isEnabled(projectDir, sessionId)) {
      return undefined;
    }

    const result = await hookManager.executePermissionRequestHooks(
      tool.name,
      sessionId,
      params,
      {
        projectDir,
        sessionId,
        permissionMode: context.permissionMode || PermissionMode.DEFAULT,
      }
    );

    if (result.decision === 'approve') {
      return 'approved';
    }
    if (result.decision === 'deny') {
      return createRejectedResult(
        result.reason || `PermissionRequest hook denied: ${tool.name}`,
        {
          shouldExitLoop: true,
          errorType: ToolErrorType.PERMISSION_DENIED,
        }
      );
    }
    return undefined;
  }

  private async persistProjectPermission(
    tool: Tool,
    invocation: ToolInvocation<unknown>,
    params: Record<string, unknown>,
    decision: 'allow' | 'deny',
    projectDir: string
  ): Promise<void> {
    const descriptor: ToolInvocationDescriptor = {
      toolName: tool.name,
      params,
      affectedPaths: invocation.getAffectedPaths() || [],
      tool,
    };
    const pattern = PermissionChecker.abstractPattern(descriptor);
    if (!pattern) {
      throw new Error(`Tool "${tool.name}" does not support project permission rules`);
    }
    if (decision === 'allow') {
      await getConfigService().appendLocalPermissionRule(pattern, {
        immediate: true,
        projectDir,
      });
    } else {
      await getConfigService().appendLocalPermissionDenyRule(pattern, {
        immediate: true,
        projectDir,
      });
    }
    this.permissionChecker.updateConfig({ [decision]: [pattern] });
  }
}

function generatePreviewForTool(
  toolName: string,
  params: Record<string, unknown>
): string | undefined {
  if (toolName === 'BrowserNavigate') {
    if (typeof params.url === 'string') {
      try {
        const target = normalizeBrowserUrl(params.url);
        return `Origin: ${target.origin}\nNetwork: ${target.classification}`;
      } catch {
        return 'Origin: invalid';
      }
    }
    if (typeof params.expectedOrigin === 'string') {
      try {
        const hostname = new URL(params.expectedOrigin).hostname;
        return (
          `Origin: ${params.expectedOrigin}\n` +
          `Network: ${classifyBrowserHostname(hostname)}`
        );
      } catch {
        return 'Origin: invalid';
      }
    }
    return 'Origin: invalid';
  }
  if (toolName === 'BrowserInteract' && typeof params.expectedOrigin === 'string') {
    let classification = 'invalid';
    try {
      classification = classifyBrowserHostname(new URL(params.expectedOrigin).hostname);
    } catch {
      // Keep invalid classification for the permission preview.
    }
    const action =
      params.action &&
      typeof params.action === 'object' &&
      !Array.isArray(params.action) &&
      typeof (params.action as Record<string, unknown>).kind === 'string'
        ? (params.action as Record<string, unknown>).kind
        : 'unknown';
    return `Origin: ${params.expectedOrigin}\nNetwork: ${classification}\nAction: ${action}`;
  }
  if (
    toolName === 'BrowserPage' &&
    params.action &&
    typeof params.action === 'object' &&
    !Array.isArray(params.action)
  ) {
    const action = (params.action as Record<string, unknown>).kind;
    return typeof action === 'string' ? `Page action: ${action}` : undefined;
  }
  if (toolName === 'Edit') {
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    if (!oldString && !newString) return undefined;
    return `**变更前:**\n\`\`\`\n${truncate(oldString || '(空)', 20)}\n\`\`\`\n\n**变更后:**\n\`\`\`\n${truncate(newString || '(删除)', 20)}\n\`\`\``;
  }

  if (toolName === 'Write') {
    const content = params.content as string;
    const encoding = (params.encoding as string) || 'utf8';
    if (encoding !== 'utf8' || !content) {
      return `将写入 ${encoding === 'base64' ? 'Base64 编码' : encoding === 'binary' ? '二进制' : ''} 内容`;
    }
    const lines = content.split('\n');
    const preview = lines.slice(0, 30).join('\n');
    return lines.length <= 30
      ? `**文件内容预览:**\n\`\`\`\n${content}\n\`\`\``
      : `**文件内容预览 (前 30 行):**\n\`\`\`\n${preview}\n\`\`\`\n\n... (还有 ${lines.length - 30} 行)`;
  }

  if (toolName === 'ApplyPatch') {
    const patchText = params.patch as string;
    if (!patchText) return undefined;
    const lines = patchText.split('\n');
    const preview = lines.slice(0, 100).join('\n');
    return lines.length <= 100
      ? `**Atomic patch preview:**\n\`\`\`diff\n${preview}\n\`\`\``
      : `**Atomic patch preview (first 100 lines):**\n\`\`\`diff\n${preview}\n\`\`\`\n\n... (${lines.length - 100} more lines)`;
  }

  return undefined;
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length <= maxLines
    ? text
    : `${lines.slice(0, maxLines).join('\n')}\n... (还有 ${lines.length - maxLines} 行)`;
}

function extractRisks(toolName: string, params: Record<string, unknown>): string[] {
  const risks: string[] = [];
  if (toolName === 'BrowserNavigate') {
    risks.push('The page may execute remote code and issue network requests');
  } else if (toolName === 'BrowserInteract') {
    risks.push('This action may submit data or change remote state');
  } else if (toolName === 'BrowserPage') {
    risks.push('This action changes local browser page state');
  } else if (toolName === 'Bash') {
    const command = (params.command as string) || '';
    if (command.includes('rm')) risks.push('[WARN] 此命令可能删除文件');
    if (command.includes('sudo')) risks.push('[WARN] 此命令需要管理员权限');
    if (command.includes('git push')) {
      risks.push('[WARN] 此命令将推送代码到远程仓库');
    }
  } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'ApplyPatch') {
    risks.push('此操作将修改文件内容');
  } else if (toolName === 'Delete') {
    risks.push('此操作将永久删除文件');
  }
  return risks;
}
