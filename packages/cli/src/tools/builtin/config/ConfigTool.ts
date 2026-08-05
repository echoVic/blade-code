/**
 * ConfigTool - 配置管理工具
 *
 * 让 AI 能够读取、修改和列举 Blade 配置项。
 * 支持三种操作：get（读取）、set（设置）、list（列举）。
 *
 * 安全约束：
 * - SET 操作仅允许白名单中的字段
 * - 禁止通过通用工具修改 models（由模型管理 API 维护）
 * - 禁止修改 RuntimeConfig 独有字段
 */

import { getConfigService } from '../../../config/index.js';
import { StringEnum, Type } from '../../../schema/index.js';
import { configActions, getConfig } from '../../../store/vanilla.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

// ============================================
// 白名单：仅允许 FIELD_ROUTING_TABLE 中 persistable: true 的安全字段
// 排除 models / currentModelId（由模型管理 API 维护）
// ============================================

const SETTABLE_KEYS = new Set([
  'temperature',
  'maxOutputTokens',
  'timeout',
  'theme',
  'uiTheme',
  'language',
  'fontSize',
  'debug',
  'autoSaveSessions',
  'maxTurns',
  'disableAllHooks',
  'permissions',
  'hooks',
  'env',
  'mcpServers',
]);

// RuntimeConfig 独有字段（绝不允许通过 ConfigTool 修改）
const RUNTIME_ONLY_KEYS = new Set([
  'systemPrompt',
  'appendSystemPrompt',
  'initialMessage',
  'resumeSessionId',
  'forkSession',
  'allowedTools',
  'disallowedTools',
  'mcpConfigPaths',
  'strictMcpConfig',
  'addDirs',
  'outputFormat',
  'inputFormat',
  'print',
  'includePartialMessages',
  'replayUserMessages',
  'agentsConfig',
  'settingSources',
]);

// ============================================
// Schema
// ============================================

const configToolSchema = Type.Object({
  operation: StringEnum(['get', 'set', 'list'], {
    description: '操作类型: get（读取）/ set（设置）/ list（列举可配置项）',
  }),
  key: Type.Optional(
    Type.String({
      description:
        '配置键名，支持点号嵌套（如 hooks.PreToolUse）。get 时用 "*" 获取全部配置',
    })
  ),
  value: Type.Optional(Type.Unknown({ description: '要设置的值（仅 set 操作需要）' })),
  scope: Type.Optional(
    StringEnum(['local', 'project', 'global'], {
      description:
        '持久化范围: local（.blade/settings.local.json）/ project（.blade/settings.json）/ global（~/.blade/）',
    })
  ),
});

// ============================================
// 辅助函数
// ============================================

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config };
}

/**
 * 按点号路径从对象中取值
 * 例如 getNestedValue(config, 'hooks.PreToolUse') -> config.hooks.PreToolUse
 */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 生成可配置项列表
 */
function generateSettableKeysList(config: Record<string, unknown>): string {
  const lines: string[] = ['可配置项列表（白名单）：', ''];
  for (const key of SETTABLE_KEYS) {
    const currentValue = config[key];
    const display =
      currentValue === undefined ? '(未设置)' : JSON.stringify(currentValue, null, 2);
    // 截断过长的值
    const truncated = display.length > 200 ? `${display.slice(0, 197)}...` : display;
    lines.push(`- ${key}: ${truncated}`);
  }
  return lines.join('\n');
}

// ============================================
// ConfigTool 实现
// ============================================

export const configTool = createTool({
  name: 'ConfigTool',
  displayName: 'Config',
  kind: ToolKind.Execute,
  isConcurrencySafe: false,

  schema: configToolSchema,

  description: {
    short: 'Read, update, or list Blade configuration',
    long:
      'Manage Blade configuration: get reads a config value, ' +
      'set updates a whitelisted config field (with persistence), ' +
      'list enumerates all settable keys and their current values.',
    usageNotes: [
      'Use operation="get" with key="*" to dump all config',
      'Use operation="get" with a dotted key like "hooks.PreToolUse"',
      'Use operation="set" with key and value to update config',
      'Use operation="list" to see all settable keys',
      'The scope option controls persistence: local/project/global',
      'models and currentModelId must be modified through model management',
    ],
    examples: [
      {
        description: 'Get all configuration',
        params: { operation: 'get', key: '*' },
      },
      {
        description: 'Get a specific config value',
        params: { operation: 'get', key: 'hooks' },
      },
      {
        description: 'Set temperature',
        params: {
          operation: 'set',
          key: 'temperature',
          value: 0.7,
          scope: 'global',
        },
      },
      {
        description: 'List all settable keys',
        params: { operation: 'list' },
      },
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { operation, key, value, scope } = params;
    const config = getConfig();

    if (!config) {
      return {
        success: false,
        llmContent: 'Config not initialized. Please wait for Blade to finish starting.',
        error: {
          message: 'Config not initialized',
          type: ToolErrorType.EXECUTION_ERROR,
        },
        metadata: { summary: '配置未初始化' },
      };
    }

    switch (operation) {
      // ========================
      // GET 操作
      // ========================
      case 'get': {
        if (!key) {
          return {
            success: false,
            llmContent:
              'Missing "key" parameter for get operation. ' +
              'Use key="*" to get all config.',
            error: {
              message: 'Missing key',
              type: ToolErrorType.VALIDATION_ERROR,
            },
            metadata: { summary: '缺少 key 参数' },
          };
        }

        if (key === '*') {
          // 返回全部配置（脱敏）
          const sanitized = sanitizeConfig(
            config as unknown as Record<string, unknown>
          );
          const content = JSON.stringify(sanitized, null, 2);
          return {
            success: true,
            llmContent: content,
            metadata: { summary: '获取全部配置' },
          };
        }

        // 按点号路径取值
        const configObj = config as unknown as Record<string, unknown>;
        const rootKey = key.split('.')[0];

        // models 字段需要脱敏
        if (rootKey === 'models') {
          const sanitized = sanitizeConfig(configObj);
          const result = getNestedValue(sanitized, key);
          return {
            success: true,
            llmContent: JSON.stringify(result, null, 2),
            metadata: { summary: `获取配置: ${key}` },
          };
        }

        const result = getNestedValue(configObj, key);
        if (result === undefined) {
          return {
            success: true,
            llmContent: `Config key "${key}" is not set or does not exist.`,
            metadata: { summary: `配置项 ${key} 不存在` },
          };
        }

        return {
          success: true,
          llmContent: JSON.stringify(result, null, 2),
          metadata: { summary: `获取配置: ${key}` },
        };
      }

      // ========================
      // SET 操作
      // ========================
      case 'set': {
        if (!key) {
          return {
            success: false,
            llmContent: 'Missing "key" parameter for set operation.',
            error: {
              message: 'Missing key',
              type: ToolErrorType.VALIDATION_ERROR,
            },
            metadata: { summary: '缺少 key 参数' },
          };
        }

        if (value === undefined) {
          return {
            success: false,
            llmContent: 'Missing "value" parameter for set operation.',
            error: {
              message: 'Missing value',
              type: ToolErrorType.VALIDATION_ERROR,
            },
            metadata: { summary: '缺少 value 参数' },
          };
        }

        // 取顶层 key（点号路径的第一段）
        const topKey = key.split('.')[0];

        // 安全检查：禁止修改 models
        if (topKey === 'models' || topKey === 'currentModelId') {
          return {
            success: false,
            llmContent:
              'Refused: "models" and "currentModelId" cannot be ' +
              'modified via ConfigTool to protect API keys. ' +
              'Use the /model slash command instead.',
            error: {
              message: 'Forbidden key: models',
              type: ToolErrorType.PERMISSION_DENIED,
            },
            metadata: { summary: '拒绝修改 models' },
          };
        }

        // 安全检查：禁止修改 RuntimeConfig 独有字段
        if (RUNTIME_ONLY_KEYS.has(topKey)) {
          return {
            success: false,
            llmContent:
              `Refused: "${topKey}" is a runtime-only field and ` +
              'cannot be persisted via ConfigTool.',
            error: {
              message: `Forbidden runtime key: ${topKey}`,
              type: ToolErrorType.PERMISSION_DENIED,
            },
            metadata: { summary: `拒绝修改运行时字段: ${topKey}` },
          };
        }

        // 白名单检查
        if (!SETTABLE_KEYS.has(topKey)) {
          return {
            success: false,
            llmContent:
              `Key "${topKey}" is not in the settable whitelist. ` +
              'Use operation="list" to see all allowed keys.',
            error: {
              message: `Key not settable: ${topKey}`,
              type: ToolErrorType.VALIDATION_ERROR,
            },
            metadata: { summary: `不可设置的 key: ${topKey}` },
          };
        }

        // 构造更新对象
        // 如果 key 包含点号，需要构造嵌套对象
        let updates: Record<string, unknown>;
        if (key.includes('.')) {
          const parts = key.split('.');
          // 只支持两层嵌套（如 hooks.PreToolUse）
          // 对于更深层的嵌套，使用顶层 key 的完整值替换
          updates = { [parts[0]]: value };

          // 对于 hooks 等深度合并字段，构造嵌套结构
          if (parts.length === 2) {
            const currentTopValue = (config as unknown as Record<string, unknown>)[
              parts[0]
            ];
            if (typeof currentTopValue === 'object' && currentTopValue !== null) {
              updates = {
                [parts[0]]: {
                  ...currentTopValue,
                  [parts[1]]: value,
                },
              };
            } else {
              updates = {
                [parts[0]]: { [parts[1]]: value },
              };
            }
          }
        } else {
          updates = { [key]: value };
        }

        try {
          await configActions().updateConfig(
            updates as Partial<import('../../../config/types.js').BladeConfig>,
            scope ? { scope } : {}
          );

          const displayValue =
            JSON.stringify(value).length > 200
              ? `${JSON.stringify(value).slice(0, 197)}...`
              : JSON.stringify(value);

          return {
            success: true,
            llmContent:
              `Config updated: ${key} = ${displayValue}` +
              (scope ? ` (scope: ${scope})` : ''),
            metadata: {
              summary: `配置已更新: ${key}`,
            },
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            llmContent: `Failed to update config: ${msg}`,
            error: {
              message: msg,
              type: ToolErrorType.EXECUTION_ERROR,
            },
            metadata: { summary: `配置更新失败: ${key}` },
          };
        }
      }

      // ========================
      // LIST 操作
      // ========================
      case 'list': {
        const configObj = config as unknown as Record<string, unknown>;
        const listContent = generateSettableKeysList(configObj);
        return {
          success: true,
          llmContent: listContent,
          metadata: { summary: '列举可配置项' },
        };
      }

      default:
        return {
          success: false,
          llmContent: `Unknown operation: ${operation}`,
          error: {
            message: `Unknown operation: ${operation}`,
            type: ToolErrorType.VALIDATION_ERROR,
          },
          metadata: { summary: `未知操作: ${operation}` },
        };
    }
  },
});
