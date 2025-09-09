/**
 * 简化的配置类型定义
 */

export interface BladeConfig {
  // 认证配置
  apiKey: string;
  baseUrl: string;
  modelName: string;

  // UI 配置
  theme: string;
  hideTips: boolean;
  hideBanner: boolean;

  // 使用配置
  maxSessionTurns: number;

  // 工具配置
  toolDiscoveryCommand: string;
  toolCallCommand: string;

  // 遥测配置
  telemetryEnabled: boolean;
  telemetryTarget: string;
  otlpEndpoint: string;
  logPrompts: boolean;
  usageStatisticsEnabled: boolean;

  // 调试配置
  debug: boolean;
}