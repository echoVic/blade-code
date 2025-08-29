/**
 * Blade 统一配置系统 - 类型定义
 * 支持分层配置：GlobalConfig、EnvConfig、UserConfig、ProjectConfig
 */

import { z } from 'zod';

// 基础配置模式
export const AuthConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().url().default('https://apis.iflow.cn/v1'),
  modelName: z.string().default('Qwen3-Coder'),
  searchApiKey: z.string().default(''),
});

export const UIConfigSchema = z.object({
  theme: z.enum(['GitHub', 'dark', 'light', 'auto']).default('GitHub'),
  hideTips: z.boolean().default(false),
  hideBanner: z.boolean().default(false),
});

export const SecurityConfigSchema = z.object({
  sandbox: z.enum(['docker', 'none']).default('docker'),
  trustedFolders: z.array(z.string()).default([]),
  allowedOperations: z.array(z.string()).default(['read', 'write', 'execute']),
});

export const ToolsConfigSchema = z.object({
  toolDiscoveryCommand: z.string().default('bin/get_tools'),
  toolCallCommand: z.string().default('bin/call_tool'),
  summarizeToolOutput: z.record(
    z.object({
      tokenBudget: z.number().min(1).optional(),
    })
  ).default({}),
});

export const MCPConfigSchema = z.object({
  mcpServers: z.record(
    z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    })
  ).default({
    main: {
      command: 'bin/mcp_server.py',
    },
  }),
});

export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  target: z.enum(['local', 'remote']).default('local'),
  otlpEndpoint: z.string().url().default('http://localhost:4317'),
  logPrompts: z.boolean().default(false),
});

export const UsageConfigSchema = z.object({
  usageStatisticsEnabled: z.boolean().default(true),
  maxSessionTurns: z.number().min(1).max(100).default(10),
  rateLimit: z.object({
    requestsPerMinute: z.number().min(1).default(60),
    requestsPerHour: z.number().min(1).default(3600),
  }).default({
    requestsPerMinute: 60,
    requestsPerHour: 3600,
  }),
});

export const DebugConfigSchema = z.object({
  debug: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  logToFile: z.boolean().default(false),
  logFilePath: z.string().default('./logs/blade.log'),
});

// 全局配置（系统级默认配置）
export const GlobalConfigSchema = z.object({
  auth: AuthConfigSchema.default({}),
  ui: UIConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  mcp: MCPConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  usage: UsageConfigSchema.default({}),
  debug: DebugConfigSchema.default({}),
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
});

// 环境配置（环境变量覆盖）
export const EnvConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
});

// 用户配置（用户级配置）
export const UserConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  currentProvider: z.enum(['qwen', 'volcengine']).optional(),
  currentModel: z.string().optional(),
  lastUpdated: z.string().datetime().optional(),
  preferences: z.object({
    autoSave: z.boolean().default(true),
    backupEnabled: z.boolean().default(true),
    backupInterval: z.number().min(1).default(3600), // 秒
  }).default({}),
});

// 项目配置（项目级配置）
export const ProjectConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  projectSpecific: z.object({
    enabled: z.boolean().default(true),
    overridesGlobal: z.boolean().default(false),
    inheritFromParent: z.boolean().default(true),
  }).default({}),
});

// 合并后的完整配置
export const BladeUnifiedConfigSchema = z.object({
  auth: AuthConfigSchema,
  ui: UIConfigSchema,
  security: SecurityConfigSchema,
  tools: ToolsConfigSchema,
  mcp: MCPConfigSchema,
  telemetry: TelemetryConfigSchema,
  usage: UsageConfigSchema,
  debug: DebugConfigSchema,
  metadata: z.object({
    sources: z.array(z.enum(['global', 'env', 'user', 'project'])).default(['global']),
    loadedAt: z.string().datetime(),
    configVersion: z.string().default('1.0.0'),
    validationErrors: z.array(z.string()).default([]),
  }).default({}),
});

// 配置状态类型
export const ConfigStateSchema = z.object({
  isValid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  lastReload: z.string().datetime(),
  configVersion: z.string(),
});

// 导出类型
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type UsageConfig = z.infer<typeof UsageConfigSchema>;
export type DebugConfig = z.infer<typeof DebugConfigSchema>;

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type EnvConfig = z.infer<typeof EnvConfigSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type BladeUnifiedConfig = z.infer<typeof BladeUnifiedConfigSchema>;
export type ConfigState = z.infer<typeof ConfigStateSchema>;

// 配置层级
export enum ConfigLayer {
  GLOBAL = 'global',
  ENV = 'env',
  USER = 'user',
  PROJECT = 'project',
}

// 配置加载优先级（优先级高的覆盖优先级低的）
export const CONFIG_PRIORITY: ConfigLayer[] = [
  ConfigLayer.ENV,      // 最高优先级：环境变量
  ConfigLayer.USER,     // 第二优先级：用户配置
  ConfigLayer.PROJECT,  // 第三优先级：项目配置
  ConfigLayer.GLOBAL,   // 最低优先级：全局默认
];

// 配置文件路径配置
export const CONFIG_PATHS = {
  global: {
    userConfig: `${process.env.HOME || process.env.USERPROFILE}/.blade/config.json`,
    userConfigLegacy: `${process.env.HOME || process.env.USERPROFILE}/.blade-config.json`,
    trustedFolders: `${process.env.HOME || process.env.USERPROFILE}/.blade/trusted-folders.json`,
  },
  project: {
    bladeConfig: './.blade/settings.local.json',
    packageJson: './package.json',
    bladeConfigRoot: './.blade/config.json',
  },
  env: {
    configFile: process.env.BLADE_CONFIG_FILE || '',
  },
};