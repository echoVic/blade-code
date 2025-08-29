/**
 * Blade 平铺化配置类型
 * 一体化配置设计，所有选项扁平化
 */

export interface BladeConfig {
  // 🔐 认证配置 (三要素)
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
  searchApiKey?: string;

  // 🎨 UI配置  
  theme?: 'GitHub' | 'dark' | 'light' | 'auto';
  hideTips?: boolean;
  hideBanner?: boolean;

  // 🔒 安全配置
  sandbox?: 'docker' | 'none';
  
  // 🛠️ 工具配置
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  summarizeToolOutput?: Record<string, { tokenBudget?: number }>;

  // 🔗 MCP配置
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;

  // 📊 遥测配置
  telemetry?: {
    enabled?: boolean;
    target?: 'local' | 'remote';
    otlpEndpoint?: string;
    logPrompts?: boolean;
  };

  // 📈 使用配置
  usageStatisticsEnabled?: boolean;
  maxSessionTurns?: number;

  // 🐝 调试配置
  debug?: boolean;
}