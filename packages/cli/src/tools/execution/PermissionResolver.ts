import {
  PermissionChecker,
  type PermissionCheckResult,
  PermissionResult,
  type ToolInvocationDescriptor,
} from '../../config/PermissionChecker.js';
import { type PermissionConfig, PermissionMode } from '../../config/types.js';
import { isReadOnlyAuditSubagent } from '../../utils/shell/readOnlyAudit.js';
import { isReadOnlyBashCommand } from '../../utils/shell/readOnlyValidation.js';
import {
  isSafeVerificationWorkingDirectory,
  isVerificationCommand,
  stripSafeStderrMerge,
} from '../../utils/shell/verificationCommand.js';
import {
  type ExecutionContext,
  isReadOnlyKind,
  type PermissionDecision,
  type Tool,
  type ToolInvocation,
  ToolKind,
} from '../types/index.js';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../validation/SensitiveFileDetector.js';
import type { SessionApprovalStore } from './SessionApprovalStore.js';

export interface RulePermissionResolution {
  decision: PermissionDecision;
  signature: string;
}

export class PermissionResolver {
  private readonly permissionChecker: PermissionChecker;

  constructor(
    permissionConfig: PermissionConfig,
    private readonly sessionApprovals: SessionApprovalStore,
    private readonly defaultPermissionMode: PermissionMode
  ) {
    this.permissionChecker = new PermissionChecker(permissionConfig);
  }

  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  resolveRulePermission(
    tool: Tool,
    invocation: ToolInvocation<unknown>,
    params: Record<string, unknown>,
    context: ExecutionContext
  ): RulePermissionResolution {
    const affectedPaths = invocation.getAffectedPaths();
    const descriptor: ToolInvocationDescriptor = {
      toolName: tool.name,
      params,
      affectedPaths,
      tool,
    };
    const signature = PermissionChecker.buildSignature(descriptor);
    let checkResult = this.permissionChecker.check(descriptor);
    if (isReadOnlyAuditSubagent(context.subagentType)) {
      const verifierBashAllowed =
        tool.name === 'Bash' &&
        typeof params.command === 'string' &&
        params.run_in_background !== true &&
        params.env === undefined &&
        isSafeVerificationWorkingDirectory(params.cwd, context.workspaceRoot) &&
        (isReadOnlyBashCommand(stripSafeStderrMerge(params.command)) ||
          isVerificationCommand(params.command));
      if (!isReadOnlyKind(tool.kind) && !verifierBashAllowed) {
        return {
          signature,
          decision: {
            behavior: 'deny',
            source: 'rule',
            matchedRule: 'builtin:audit-agent-read-only',
            reason:
              'Audit agents may only use read-only tools and verification commands',
          },
        };
      }
      if (verifierBashAllowed) {
        if (checkResult.result === PermissionResult.DENY) {
          return {
            signature,
            decision: toPermissionDecision(checkResult),
          };
        }
        return {
          signature,
          decision: {
            behavior: 'allow',
            source: 'rule',
            matchedRule: 'builtin:audit-agent-command',
            reason: 'Verification command allowed for the read-only audit agent',
          },
        };
      }
    }

    if (
      checkResult.result === PermissionResult.ASK &&
      !checkResult.matchedRule &&
      tool.name === 'Bash' &&
      typeof params.command === 'string' &&
      isReadOnlyBashCommand(params.command)
    ) {
      checkResult = {
        result: PermissionResult.ALLOW,
        matchedRule: 'builtin:read-only-command',
        reason: 'Command classified as read-only, auto-approved',
      };
    }

    checkResult = this.applyModeOverrides(
      tool.kind,
      checkResult,
      context.permissionMode ?? this.defaultPermissionMode
    );

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

    checkResult = this.applySafetyOverrides(affectedPaths, checkResult);

    return {
      decision: toPermissionDecision(checkResult),
      signature,
    };
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

    if (permissionMode === PermissionMode.PLAN && !isReadOnlyKind(toolKind)) {
      return {
        result: PermissionResult.DENY,
        matchedRule: 'mode:plan',
        reason:
          'Plan mode: modification tools are blocked; only read-only tools are allowed',
      };
    }

    if (checkResult.result !== PermissionResult.ASK) {
      return checkResult;
    }

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

  private applySafetyOverrides(
    affectedPaths: string[] | undefined,
    checkResult: PermissionCheckResult
  ): PermissionCheckResult {
    if (!affectedPaths?.length) {
      return checkResult;
    }

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
    const dangerousPaths = affectedPaths.filter(
      (filePath) =>
        filePath.includes('..') ||
        dangerousSystemPaths.some((dangerousPath) => filePath.includes(dangerousPath))
    );

    if (dangerousPaths.length > 0) {
      return {
        result: PermissionResult.DENY,
        matchedRule: 'safety:dangerous-system-path',
        reason: `Access to dangerous system paths denied: ${dangerousPaths.join(', ')}`,
      };
    }

    const sensitiveFiles = SensitiveFileDetector.filterSensitive(
      affectedPaths,
      SensitivityLevel.MEDIUM
    );
    if (sensitiveFiles.length === 0) {
      return checkResult;
    }

    const warnings = sensitiveFiles.map(
      ({ path: filePath, result }) => `${filePath} (${result.level}: ${result.reason})`
    );
    const hasHighSensitivity = sensitiveFiles.some(
      ({ result }) => result.level === SensitivityLevel.HIGH
    );

    if (hasHighSensitivity && checkResult.result !== PermissionResult.ALLOW) {
      return {
        result: PermissionResult.DENY,
        matchedRule: 'safety:high-sensitive-file',
        reason: `Access to highly sensitive files denied:\n${warnings.join('\n')}\n\nIf access is required, add an explicit allow rule in permissions.`,
      };
    }

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

export function resolvePermissionDecision(
  rule: PermissionDecision | undefined,
  hook: PermissionDecision | undefined
): PermissionDecision {
  if (rule?.behavior === 'deny') return rule;
  if (hook?.behavior === 'deny') return hook;
  if (hook?.behavior === 'ask') return hook;
  if (rule?.behavior === 'ask') return rule;
  if (rule?.behavior === 'allow') return rule;
  if (hook?.behavior === 'allow') return hook;

  return {
    behavior: 'ask',
    source: 'default',
    reason: 'No permission rule or hook decision; defaulting to ask',
  };
}

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
