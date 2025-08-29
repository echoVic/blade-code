/**
 * Blade 统一配置系统 - Zod 配置验证 Schema
 */

import { z } from 'zod';

// 认证配置 Schema
export const AuthConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().url().default('https://apis.iflow.cn/v1'),
  modelName: z.string().default('Qwen3-Coder'),
  searchApiKey: z.string().default(''),
  timeout: z.number().min(1000).max(300000).default(30000),
  maxTokens: z.number().min(1).max(100000).default(4000),
  temperature: z.number().min(0).max(2).default(0.7),
  stream: z.boolean().default(true),
});

// UI 配置 Schema
export const UIConfigSchema = z.object({
  theme: z.enum(['GitHub', 'dark', 'light', 'auto']).default('GitHub'),
  hideTips: z.boolean().default(false),
  hideBanner: z.boolean().default(false),
  outputFormat: z.enum(['text', 'json', 'markdown']).default('text'),
  colorScheme: z.enum(['default', 'monokai', 'solarized']).default('default'),
  fontSize: z.number().min(8).max(32).default(14),
  lineHeight: z.number().min(1).max(3).default(1.5),
});

// 安全配置 Schema
export const SecurityConfigSchema = z.object({
  sandbox: z.enum(['docker', 'none']).default('docker'),
  trustedFolders: z.array(z.string()).default([]),
  allowedOperations: z.array(z.enum(['read', 'write', 'execute', 'network'])).default(['read', 'write', 'execute']),
  requireConfirmation: z.boolean().default(true),
  disableSafetyChecks: z.boolean().default(false),
  maxFileSize: z.number().min(1024).max(1024 * 1024 * 100).default(1024 * 1024 * 10), // 10MB
});

// 工具配置 Schema
export const ToolsConfigSchema = z.object({
  toolDiscoveryCommand: z.string().default('bin/get_tools'),
  toolCallCommand: z.string().default('bin/call_tool'),
  summarizeToolOutput: z.record(
    z.object({
      tokenBudget: z.number().min(1).optional(),
      enabled: z.boolean().default(true),
      maxOutputLength: z.number().min(100).optional(),
    })
  ).default({}),
  autoUpdate: z.boolean().default(true),
  toolTimeout: z.number().min(1000).max(300000).default(30000),
});

// MCP 配置 Schema
export const MCPConfigSchema = z.object({
  mcpServers: z.record(
    z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      workingDir: z.string().optional(),
      autoStart: z.boolean().default(true),
      timeout: z.number().min(1000).max(300000).default(30000),
    })
  ).default({
    main: {
      command: 'bin/mcp_server.py',
      autoStart: true,
    },
  }),
  maxRetries: z.number().min(0).max(10).default(3),
  retryDelay: z.number().min(100).max(10000).default(1000),
});

// 遥测配置 Schema
export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  target: z.enum(['local', 'remote']).default('local'),
  otlpEndpoint: z.string().url().default('http://localhost:4317'),
  logPrompts: z.boolean().default(false),
  logResponses: z.boolean().default(false),
  batchSize: z.number().min(1).max(1000).default(100),
  flushInterval: z.number().min(1000).max(60000).default(10000),
});

// 使用配置 Schema
export const UsageConfigSchema = z.object({
  usageStatisticsEnabled: z.boolean().default(true),
  maxSessionTurns: z.number().min(1).max(100).default(10),
  rateLimit: z.object({
    requestsPerMinute: z.number().min(1).default(60),
    requestsPerHour: z.number().min(1).default(3600),
    requestsPerDay: z.number().min(1).default(86400),
  }).default({
    requestsPerMinute: 60,
    requestsPerHour: 3600,
    requestsPerDay: 86400,
  }),
  sessionTimeout: z.number().min(60000).max(3600000).default(1800000), // 30分钟
  conversationHistory: z.object({
    maxMessages: z.number().min(1).max(1000).default(100),
    maxTokens: z.number().min(1000).max(100000).default(10000),
    ttl: z.number().min(3600000).max(604800000).default(86400000), // 24小时
  }).default({
    maxMessages: 100,
    maxTokens: 10000,
    ttl: 86400000,
  }),
});

// 调试配置 Schema
export const DebugConfigSchema = z.object({
  debug: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  logToFile: z.boolean().default(false),
  logFilePath: z.string().default('./logs/blade.log'),
  logRotation: z.object({
    maxSize: z.string().default('10MB'),
    maxFiles: z.number().min(1).max(100).default(5),
    compress: z.boolean().default(true),
  }).default({
    maxSize: '10MB',
    maxFiles: 5,
    compress: true,
  }),
  performanceMonitoring: z.object({
    enabled: z.boolean().default(true),
    samplingRate: z.number().min(0.01).max(1).default(0.1),
    reportInterval: z.number().min(1000).max(60000).default(10000),
  }).default({
    enabled: true,
    samplingRate: 0.1,
    reportInterval: 10000,
  }),
});

// 扩展配置 Schema
export const ExtensionsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default('./extensions'),
  autoLoad: z.boolean().default(true),
  allowedExtensions: z.array(z.string()).default(['.js', '.ts', '.json']),
  dependencies: z.record(z.string()).default({}),
  security: z.object({
    codeSigning: z.boolean().default(true),
    sandbox: z.boolean().default(true),
    networkAccess: z.boolean().default(false),
  }).default({
    codeSigning: true,
    sandbox: true,
    networkAccess: false,
  }),
});

// 全局配置 Schema（系统级默认配置）
export const GlobalConfigSchema = z.object({
  auth: AuthConfigSchema.default({}),
  ui: UIConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  mcp: MCPConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  usage: UsageConfigSchema.default({}),
  debug: DebugConfigSchema.default({}),
  extensions: ExtensionsConfigSchema.default({}),
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  isValid: z.boolean().default(true),
});

// 环境配置 Schema（环境变量覆盖）
export const EnvConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  extensions: ExtensionsConfigSchema.partial().default({}),
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  isValid: z.boolean().default(true),
});

// 用户配置 Schema（用户级配置）
export const UserConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  extensions: ExtensionsConfigSchema.partial().default({}),
  currentProvider: z.enum(['qwen', 'volcengine']).optional(),
  currentModel: z.string().optional(),
  lastUpdated: z.string().datetime().optional(),
  preferences: z.object({
    autoSave: z.boolean().default(true),
    backupEnabled: z.boolean().default(true),
    backupInterval: z.number().min(1).default(3600), // 秒
    autoUpdate: z.boolean().default(true),
    telemetryOptIn: z.boolean().default(true),
    darkMode: z.boolean().default(false),
  }).default({}),
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  isValid: z.boolean().default(true),
});

// 项目配置 Schema（项目级配置）
export const ProjectConfigSchema = z.object({
  auth: AuthConfigSchema.partial().default({}),
  ui: UIConfigSchema.partial().default({}),
  security: SecurityConfigSchema.partial().default({}),
  tools: ToolsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
  telemetry: TelemetryConfigSchema.partial().default({}),
  usage: UsageConfigSchema.partial().default({}),
  debug: DebugConfigSchema.partial().default({}),
  extensions: ExtensionsConfigSchema.partial().default({}),
  projectSpecific: z.object({
    enabled: z.boolean().default(true),
    overridesGlobal: z.boolean().default(false),
    inheritFromParent: z.boolean().default(true),
    environment: z.enum(['development', 'staging', 'production']).default('development'),
    features: z.record(z.boolean()).default({}),
  }).default({}),
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  isValid: z.boolean().default(true),
});

// 合并后的完整配置 Schema
export const BladeUnifiedConfigSchema = z.object({
  auth: AuthConfigSchema,
  ui: UIConfigSchema,
  security: SecurityConfigSchema,
  tools: ToolsConfigSchema,
  mcp: MCPConfigSchema,
  telemetry: TelemetryConfigSchema,
  usage: UsageConfigSchema,
  debug: DebugConfigSchema,
  extensions: ExtensionsConfigSchema,
  metadata: z.object({
    sources: z.array(z.enum(['global', 'env', 'user', 'project'])).default(['global']),
    loadedAt: z.string().datetime(),
    configVersion: z.string().default('1.0.0'),
    validationErrors: z.array(z.string()).default([]),
    validationWarnings: z.array(z.string()).default([]),
    mergeConflicts: z.array(z.object({
      path: z.string(),
      sources: z.array(z.string()),
      resolution: z.string(),
    })).default([]),
  }).default({}),
});

// 配置状态 Schema
export const ConfigStateSchema = z.object({
  isValid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  lastReload: z.string().datetime(),
  configVersion: z.string(),
  loadedLayers: z.array(z.enum(['global', 'env', 'user', 'project'])),
  configHash: z.string(),
});

// 环境变量映射 Schema
export const EnvMappingSchema = z.record(z.string(), z.string());

// 导出类型
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type UsageConfig = z.infer<typeof UsageConfigSchema>;
export type DebugConfig = z.infer<typeof DebugConfigSchema>;
export type ExtensionsConfig = z.infer<typeof ExtensionsConfigSchema>;

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type EnvConfig = z.infer<typeof EnvConfigSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type BladeUnifiedConfig = z.infer<typeof BladeUnifiedConfigSchema>;
export type ConfigState = z.infer<typeof ConfigStateSchema>;
export type EnvMapping = z.infer<typeof EnvMappingSchema>;

// 预定义的环境变量映射
export const ENV_MAPPING: EnvMapping = {
  // 认证配置
  BLADE_API_KEY: 'auth.apiKey',
  BLADE_BASE_URL: 'auth.baseUrl',
  BLADE_MODEL: 'auth.modelName',
  BLADE_SEARCH_API_KEY: 'auth.searchApiKey',
  BLADE_TIMEOUT: 'auth.timeout',
  BLADE_MAX_TOKENS: 'auth.maxTokens',
  BLADE_TEMPERATURE: 'auth.temperature',
  BLADE_STREAM: 'auth.stream',
  
  // UI 配置
  BLADE_THEME: 'ui.theme',
  BLADE_HIDE_TIPS: 'ui.hideTips',
  BLADE_HIDE_BANNER: 'ui.hideBanner',
  BLADE_OUTPUT_FORMAT: 'ui.outputFormat',
  BLADE_COLOR_SCHEME: 'ui.colorScheme',
  
  // 安全配置
  BLADE_SANDBOX: 'security.sandbox',
  BLADE_TRUSTED_FOLDERS: 'security.trustedFolders',
  BLADE_DISABLE_SAFETY_CHECKS: 'security.disableSafetyChecks',
  
  // 工具配置
  BLADE_TOOL_DISCOVERY_COMMAND: 'tools.toolDiscoveryCommand',
  BLADE_TOOL_CALL_COMMAND: 'tools.toolCallCommand',
  
  // 遥测配置
  BLADE_TELEMETRY_ENABLED: 'telemetry.enabled',
  BLADE_TELEMETRY_TARGET: 'telemetry.target',
  BLADE_TELEMETRY_ENDPOINT: 'telemetry.otlpEndpoint',
  
  // 使用配置
  BLADE_MAX_TURNS: 'usage.maxSessionTurns',
  BLADE_USAGE_STATS: 'usage.usageStatisticsEnabled',
  
  // 调试配置
  BLADE_DEBUG: 'debug.debug',
  BLADE_LOG_LEVEL: 'debug.logLevel',
  BLADE_LOG_TO_FILE: 'debug.logToFile',
  
  // 扩展配置
  BLADE_EXTENSIONS_ENABLED: 'extensions.enabled',
  BLADE_EXTENSIONS_DIR: 'extensions.directory',
};