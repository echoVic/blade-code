import type { ConfirmationDetails, ExecutionContext } from './ExecutionTypes.js';
import type { ToolInvocation } from './ToolTypes.js';

/**
 * 权限级别
 */
export enum PermissionLevel {
  Allow = 'allow', // 自动允许
  Deny = 'deny', // 自动拒绝
  Ask = 'ask', // 询问用户
}

/**
 * 权限检查结果
 */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * 验证错误
 */
export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * 安全策略配置
 */
export interface SecurityPolicyConfig {
  defaultPermission: PermissionLevel;
  trustedPaths: string[];
  trustedServers: string[];
  dangerousOperations: string[];
  requireConfirmationFor: string[];
}

/**
 * 确认结果
 */
export interface ConfirmationOutcome {
  confirmed: boolean;
  rememberChoice?: boolean;
  customMessage?: string;
}

/**
 * 验证器接口
 */
export interface Validator {
  validate(params: any): ValidationResult;
}

/**
 * 权限检查器接口
 */
export interface PermissionChecker {
  checkPermission(
    toolInvocation: ToolInvocation,
    context: ExecutionContext
  ): Promise<PermissionResult>;
}

/**
 * 确认服务接口
 */
export interface ConfirmationService {
  requestConfirmation(details: ConfirmationDetails): Promise<ConfirmationOutcome>;

  rememberChoice(pattern: string, outcome: ConfirmationOutcome): void;
}
