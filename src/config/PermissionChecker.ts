/**
 * Blade 权限检查器
 * 实现 allow/ask/deny 三级权限控制
 * 支持精确匹配、前缀匹配、通配符匹配和 glob 模式
 */

import picomatch from 'picomatch';
import type { PermissionConfig } from './types.js';

/**
 * 权限检查结果
 */
export enum PermissionResult {
  /** 允许执行 */
  ALLOW = 'allow',
  /** 需要用户确认 */
  ASK = 'ask',
  /** 拒绝执行 */
  DENY = 'deny',
}

/**
 * 权限检查详情
 */
export interface PermissionCheckResult {
  /** 检查结果 */
  result: PermissionResult;
  /** 匹配的规则 */
  matchedRule?: string;
  /** 匹配类型 */
  matchType?: 'exact' | 'prefix' | 'wildcard' | 'glob';
  /** 原因说明 */
  reason?: string;
}

/**
 * 工具调用描述
 */
export interface ToolInvocationDescriptor {
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 受影响的路径 */
  affectedPaths?: string[];
}

/**
 * 权限检查器
 */
export class PermissionChecker {
  constructor(private config: PermissionConfig) {}

  /**
   * 检查工具调用权限
   */
  check(descriptor: ToolInvocationDescriptor): PermissionCheckResult {
    const signature = PermissionChecker.buildSignature(descriptor);

    // 优先级: deny > allow > ask > 默认(ask)

    // 1. 检查 deny 规则 (最高优先级)
    const denyMatch = this.matchRules(signature, this.config.deny);
    if (denyMatch) {
      return {
        result: PermissionResult.DENY,
        matchedRule: denyMatch.rule,
        matchType: denyMatch.type,
        reason: `工具调用被拒绝规则阻止: ${denyMatch.rule}`,
      };
    }

    // 2. 检查 allow 规则
    const allowMatch = this.matchRules(signature, this.config.allow);
    if (allowMatch) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: allowMatch.rule,
        matchType: allowMatch.type,
        reason: `工具调用符合允许规则: ${allowMatch.rule}`,
      };
    }

    // 3. 检查 ask 规则
    const askMatch = this.matchRules(signature, this.config.ask);
    if (askMatch) {
      return {
        result: PermissionResult.ASK,
        matchedRule: askMatch.rule,
        matchType: askMatch.type,
        reason: `工具调用需要用户确认: ${askMatch.rule}`,
      };
    }

    // 4. 默认策略: 需要确认
    return {
      result: PermissionResult.ASK,
      reason: '工具调用未匹配任何规则,默认需要确认',
    };
  }

  /**
   * 构建工具调用签名
   * 格式: ToolName(param1:value1, param2:value2)
   *
   * 智能参数过滤策略:
   * - Read/Edit/Write: 只保留核心路径参数,忽略 offset/limit
   * - Bash: 保留完整命令
   * - Grep: 保留 pattern 和 path,忽略 output_mode 等
   * - 其他工具: 保留所有参数
   */
  static buildSignature(descriptor: ToolInvocationDescriptor): string {
    const { toolName, params } = descriptor;

    // 工具特定的参数过滤
    const filteredParams = PermissionChecker._normalizeParams(toolName, params);

    // 简化参数表示
    const paramPairs = Object.entries(filteredParams)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return `${key}:${value}`;
        }
        return `${key}:${JSON.stringify(value)}`;
      });

    if (paramPairs.length === 0) {
      return toolName;
    }

    return `${toolName}(${paramPairs.join(', ')})`;
  }

  /**
   * 标准化参数 - 工具特定的参数过滤逻辑
   * 目标: 减少权限签名的粒度,避免频繁确认
   */
  private static _normalizeParams(
    toolName: string,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    switch (toolName) {
      case 'Read':
      case 'Edit':
      case 'Write':
        // 文件操作: 只保留 file_path/old_string/new_string/content
        // 忽略 offset/limit/replace_all 等易变参数
        return {
          file_path: params.file_path,
          old_string: params.old_string,
          new_string: params.new_string,
          content: params.content,
        };

      case 'Grep':
        // 搜索操作: 只保留 pattern 和 path/glob/type
        // 忽略 output_mode/-A/-B/-C/-i/-n/head_limit 等显示选项
        return {
          pattern: params.pattern,
          path: params.path,
          glob: params.glob,
          type: params.type,
        };

      case 'Glob':
        // Glob 操作: 保留 pattern 和 path
        return {
          pattern: params.pattern,
          path: params.path,
        };

      case 'Bash':
        // Bash 命令: 保留完整的 command 和 description
        return {
          command: params.command,
          description: params.description,
        };

      case 'WebFetch':
        // Web 请求: 保留 url 和 domain(如果有)
        return {
          url: params.url,
          domain: params.domain,
        };

      default:
        // 其他工具: 保留所有参数
        return params;
    }
  }

  /**
   * 匹配规则列表
   */
  private matchRules(
    signature: string,
    rules: string[]
  ): { rule: string; type: 'exact' | 'prefix' | 'wildcard' | 'glob' } | null {
    for (const rule of rules) {
      const matchType = this.matchRule(signature, rule);
      if (matchType) {
        return { rule, type: matchType };
      }
    }
    return null;
  }

  /**
   * 匹配单条规则
   * 支持以下匹配模式:
   * 1. 精确匹配: Read(file_path:/path/to/file.txt)
   * 2. 前缀匹配: Read
   * 3. 通配符匹配: Read(*) 或 Read(file_path:*.env)
   * 4. Glob 模式: Read(file_path:star-star-slash-star.env)
   */
  private matchRule(
    signature: string,
    rule: string
  ): 'exact' | 'prefix' | 'wildcard' | 'glob' | null {
    // 1. 精确匹配
    if (signature === rule) {
      return 'exact';
    }

    // 2. 通配符匹配所有工具
    if (rule === '*' || rule === '**') {
      return 'wildcard';
    }

    // 3. 提取工具名和参数
    const sigToolName = this.extractToolName(signature);
    const ruleToolName = this.extractToolName(rule);

    // 工具名不匹配则直接返回
    if (!sigToolName || !ruleToolName) {
      return null;
    }

    // 工具名使用 glob 匹配
    if (ruleToolName.includes('*')) {
      if (!picomatch.isMatch(sigToolName, ruleToolName, { dot: true })) {
        return null;
      }
    } else if (sigToolName !== ruleToolName) {
      return null;
    }

    // 3. 前缀匹配 (仅工具名)
    if (rule === ruleToolName) {
      return 'prefix';
    }

    // 4. 参数匹配 (包含通配符或 glob)
    if (rule.includes('*')) {
      // 提取参数部分进行匹配
      const sigParams = this.extractParams(signature);
      const ruleParams = this.extractParams(rule);

      // 如果规则参数为 * 或 (**),匹配任何参数
      if (ruleParams === '*' || ruleParams === '**') {
        return 'wildcard';
      }

      // 尝试参数值级别的 glob 匹配
      const paramMatch = this.matchParams(sigParams, ruleParams);
      if (paramMatch) {
        return ruleParams.includes('**') ? 'glob' : 'wildcard';
      }

      // 尝试完整签名的 glob 匹配
      if (picomatch.isMatch(signature, rule, { dot: true })) {
        return rule.includes('**') ? 'glob' : 'wildcard';
      }
    }

    return null;
  }

  /**
   * 提取参数部分
   */
  private extractParams(signature: string): string {
    const match = signature.match(/\((.*)\)$/);
    return match ? match[1] : '';
  }

  /**
   * 匹配参数
   * 支持对参数值进行 glob 匹配
   */
  private matchParams(sigParams: string, ruleParams: string): boolean {
    if (!sigParams || !ruleParams) {
      return false;
    }

    // 解析参数键值对
    const sigPairs = this.parseParamPairs(sigParams);
    const rulePairs = this.parseParamPairs(ruleParams);

    // 检查每个规则参数是否匹配
    for (const [ruleKey, ruleValue] of Object.entries(rulePairs)) {
      const sigValue = sigPairs[ruleKey];

      // 参数不存在
      if (sigValue === undefined) {
        return false;
      }

      // 使用 glob 匹配参数值 (包括 * 和 {} 模式)
      if (
        ruleValue.includes('*') ||
        ruleValue.includes('{') ||
        ruleValue.includes('?')
      ) {
        if (!picomatch.isMatch(sigValue, ruleValue, { dot: true })) {
          return false;
        }
      } else if (sigValue !== ruleValue) {
        // 精确匹配
        return false;
      }
    }

    return true;
  }

  /**
   * 解析参数对
   * 支持嵌套的花括号和括号
   */
  private parseParamPairs(params: string): Record<string, string> {
    const pairs: Record<string, string> = {};

    // 智能分割,考虑花括号和括号嵌套
    const parts = this.smartSplit(params, ',');

    for (const part of parts) {
      const colonIndex = part.indexOf(':');
      if (colonIndex > 0) {
        const key = part.slice(0, colonIndex).trim();
        const value = part.slice(colonIndex + 1).trim();
        pairs[key] = value;
      }
    }

    return pairs;
  }

  /**
   * 智能分割字符串,忽略括号和花括号内的分隔符
   */
  private smartSplit(str: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;
      else if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;
      else if (char === '[') bracketDepth++;
      else if (char === ']') bracketDepth--;

      if (
        char === delimiter &&
        braceDepth === 0 &&
        parenDepth === 0 &&
        bracketDepth === 0
      ) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current) {
      result.push(current.trim());
    }

    return result;
  }

  /**
   * 从签名中提取工具名称
   */
  private extractToolName(signature: string): string | null {
    const match = signature.match(/^([A-Za-z0-9_]+)(\(|$)/);
    return match ? match[1] : null;
  }

  /**
   * 检查是否允许执行 (不需要确认)
   */
  isAllowed(descriptor: ToolInvocationDescriptor): boolean {
    return this.check(descriptor).result === PermissionResult.ALLOW;
  }

  /**
   * 检查是否被拒绝
   */
  isDenied(descriptor: ToolInvocationDescriptor): boolean {
    return this.check(descriptor).result === PermissionResult.DENY;
  }

  /**
   * 检查是否需要确认
   */
  needsConfirmation(descriptor: ToolInvocationDescriptor): boolean {
    return this.check(descriptor).result === PermissionResult.ASK;
  }

  /**
   * 更新权限配置
   */
  updateConfig(config: Partial<PermissionConfig>): void {
    if (config.allow) {
      this.config.allow = [...this.config.allow, ...config.allow];
    }
    if (config.ask) {
      this.config.ask = [...this.config.ask, ...config.ask];
    }
    if (config.deny) {
      this.config.deny = [...this.config.deny, ...config.deny];
    }
  }

  /**
   * 获取当前权限配置
   */
  getConfig(): PermissionConfig {
    return { ...this.config };
  }
}
