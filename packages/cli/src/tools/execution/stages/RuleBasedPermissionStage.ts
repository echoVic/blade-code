import {
  PermissionChecker,
  type PermissionCheckResult,
  PermissionResult,
  type ToolInvocationDescriptor,
} from '../../../config/PermissionChecker.js';
import { type PermissionConfig, PermissionMode } from '../../../config/types.js';
import { isReadOnlyBashCommand } from '../../../utils/shell/readOnlyValidation.js';
import {
  isReadOnlyKind,
  type PermissionDecision,
  type PipelineStage,
  type ToolExecution,
  ToolKind,
} from '../../types/index.js';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../../validation/SensitiveFileDetector.js';
import type { SessionApprovalStore } from '../SessionApprovalStore.js';

/**
 * 规则库权限阶段
 *
 * 职责(纯函数式,只读):
 * 1. 构建工具签名 (用于会话批准与后续持久化)
 * 2. PermissionChecker 规则匹配 (allow/ask/deny)
 * 3. 只读 Bash 命令自动放行 (语义分析保底)
 * 4. 权限模式覆盖 (YOLO/PLAN/AUTO_EDIT/DEFAULT)
 * 5. 会话级批准升级 (ASK → ALLOW)
 * 6. 危险系统路径硬拒绝
 * 7. 敏感文件调整 (HIGH → DENY; MEDIUM → ASK)
 *
 * 产出: execution._internal.ruleDecision
 * 不再直接设置 needsConfirmation 或 abort — 交给 ResolveDecisionStage 仲裁。
 *
 * 例外: 危险系统路径直接 abort (硬不变量,Hook 无法覆盖)。
 */
export class RuleBasedPermissionStage implements PipelineStage {
  readonly name = 'rule-permission';

  private permissionChecker: PermissionChecker;
  private readonly sessionApprovals: SessionApprovalStore;
  private readonly defaultPermissionMode: PermissionMode;

  constructor(
    permissionConfig: PermissionConfig,
    sessionApprovals: SessionApprovalStore,
    permissionMode: PermissionMode
  ) {
    this.permissionChecker = new PermissionChecker(permissionConfig);
    this.sessionApprovals = sessionApprovals;
    this.defaultPermissionMode = permissionMode;
  }

  /** 供 ConfirmationStage 持久化会话批准时使用 */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  async process(execution: ToolExecution): Promise<void> {
    const { tool, invocation } = execution._internal;
    if (!tool || !invocation) {
      execution.abort('Validation stage failed; cannot perform permission check');
      return;
    }

    try {
      const affectedPaths = invocation.getAffectedPaths();
      const descriptor: ToolInvocationDescriptor = {
        toolName: tool.name,
        params: execution.params,
        affectedPaths,
        tool,
      };

      const signature = PermissionChecker.buildSignature(descriptor);
      execution._internal.permissionSignature = signature;

      let checkResult = this.permissionChecker.check(descriptor);

      // 只读 Bash 自动放行(仅在无显式规则匹配时生效)
      if (
        checkResult.result === PermissionResult.ASK &&
        !checkResult.matchedRule &&
        tool.name === 'Bash' &&
        typeof execution.params.command === 'string'
      ) {
        if (isReadOnlyBashCommand(execution.params.command)) {
          checkResult = {
            result: PermissionResult.ALLOW,
            matchedRule: 'builtin:read-only-command',
            reason: 'Command classified as read-only, auto-approved',
          };
        }
      }

      // 从 context 动态读取 permissionMode, 支持运行时切换 (Shift+Tab)
      const currentPermissionMode =
        execution.context.permissionMode || this.defaultPermissionMode;
      checkResult = this.applyModeOverrides(
        tool.kind,
        checkResult,
        currentPermissionMode
      );

      // 会话级批准升级: ASK → ALLOW
      if (
        checkResult.result === PermissionResult.ASK &&
        this.sessionApprovals.has(signature)
      ) {
        checkResult = {
          result: PermissionResult.ALLOW,
          matchedRule: 'remembered:session',
          reason: 'User already allowed this operation in this session',
        };
      }

      // 危险路径硬拒绝 + 敏感文件调整
      checkResult = this.applySafetyOverrides(affectedPaths, checkResult, execution);

      // 若 applySafetyOverrides 已 abort,直接返回
      if (execution.shouldAbort()) {
        return;
      }

      execution._internal.ruleDecision = toPermissionDecision(checkResult);
    } catch (error) {
      execution.abort(`Permission check failed: ${(error as Error).message}`);
    }
  }

  private applyModeOverrides(
    toolKind: ToolKind,
    checkResult: PermissionCheckResult,
    permissionMode: PermissionMode
  ): PermissionCheckResult {
    if (permissionMode === PermissionMode.YOLO) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:yolo',
        reason: 'YOLO mode: automatically approve all tool invocations',
      };
    }

    if (permissionMode === PermissionMode.PLAN) {
      if (!isReadOnlyKind(toolKind)) {
        return {
          result: PermissionResult.DENY,
          matchedRule: 'mode:plan',
          reason:
            'Plan mode: modification tools are blocked; only read-only tools are allowed',
        };
      }
    }

    if (checkResult.result === PermissionResult.DENY) return checkResult;
    if (checkResult.result === PermissionResult.ALLOW) return checkResult;

    if (isReadOnlyKind(toolKind)) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: `mode:${permissionMode}:readonly`,
        reason: 'Read-only tools do not require confirmation',
      };
    }

    if (permissionMode === PermissionMode.AUTO_EDIT && toolKind === ToolKind.Write) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:autoEdit:write',
        reason: 'AUTO_EDIT mode: automatically approve write tools',
      };
    }

    return checkResult;
  }

  /**
   * 危险路径 & 敏感文件处理
   * - 危险系统路径: 直接 execution.abort (硬不变量)
   * - 高度敏感文件: DENY (除非已有明确 allow 规则)
   * - 中度敏感文件: 降级为 ASK,并携带警告原因
   */
  private applySafetyOverrides(
    affectedPaths: string[] | undefined,
    checkResult: PermissionCheckResult,
    execution: ToolExecution
  ): PermissionCheckResult {
    if (!affectedPaths || affectedPaths.length === 0) return checkResult;

    const dangerousSystemPaths = [
      '/etc/',
      '/sys/',
      '/proc/',
      '/dev/',
      '/boot/',
      '/root/',
      'C:\\Windows\\System32',
      'C:\\Program Files',
      'C:\\ProgramData',
    ];

    const dangerousPaths = affectedPaths.filter((filePath) => {
      if (filePath.includes('..')) return true;
      return dangerousSystemPaths.some((d) => filePath.includes(d));
    });

    if (dangerousPaths.length > 0) {
      execution.abort(
        `Access to dangerous system paths denied: ${dangerousPaths.join(', ')}`
      );
      return checkResult;
    }

    const sensitiveFiles = SensitiveFileDetector.filterSensitive(
      affectedPaths,
      SensitivityLevel.MEDIUM
    );

    if (sensitiveFiles.length === 0) return checkResult;

    const warnings = sensitiveFiles.map(
      ({ path: filePath, result }) => `${filePath} (${result.level}: ${result.reason})`
    );

    const highSensitiveFiles = sensitiveFiles.filter(
      ({ result }) => result.level === SensitivityLevel.HIGH
    );

    // 高度敏感 + 未明确 allow → 拒绝
    if (
      highSensitiveFiles.length > 0 &&
      checkResult.result !== PermissionResult.ALLOW
    ) {
      return {
        result: PermissionResult.DENY,
        matchedRule: 'safety:high-sensitive-file',
        reason: `Access to highly sensitive files denied:\n${warnings.join('\n')}\n\nIf access is required, add an explicit allow rule in permissions.`,
      };
    }

    // 中度敏感 + 被 allow → 降级为 ASK
    if (checkResult.result === PermissionResult.ALLOW) {
      return {
        result: PermissionResult.ASK,
        matchedRule: 'safety:sensitive-file',
        reason: `Sensitive file access detected:\n${warnings.join('\n')}\n\nConfirm to proceed?`,
      };
    }

    return checkResult;
  }
}

/** 将 PermissionCheckResult 转为 PermissionDecision */
function toPermissionDecision(result: PermissionCheckResult): PermissionDecision {
  return {
    behavior:
      result.result === PermissionResult.ALLOW
        ? 'allow'
        : result.result === PermissionResult.DENY
          ? 'deny'
          : 'ask',
    source: 'rule',
    reason: result.reason,
    matchedRule: result.matchedRule,
  };
}
