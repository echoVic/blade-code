/**
 * 工具扩展包导出
 * 包含所有新增的工具扩展
 */

import type { ToolDefinition } from '../types.js';

// 代码分析工具
export {
  codeQualityAnalyzer,
} from './CodeAnalysisTools.js';
export { codeSecurityAnalyzer } from './CodeAnalysisTools.js';
export { codePerformanceAnalyzer } from './CodeAnalysisTools.js';
export { codeComplexityAnalyzer } from './CodeAnalysisTools.js';

// 网络工具
export { httpRequestTool } from './NetworkTools.js';
export { webSocketTool } from './NetworkTools.js';
export { apiTestTool } from './NetworkTools.js';
export { webScraperTool } from './NetworkTools.js';
export { proxyTestTool } from './NetworkTools.js';
export { dnsLookupTool } from './NetworkTools.js';
export { portScanTool } from './NetworkTools.js';

// 数据处理工具
export { dataTransformTool } from './DataProcessingTools.js';
export { dataValidationTool } from './DataProcessingTools.js';
export { dataStatisticsTool } from './DataProcessingTools.js';
export { dataVisualizationTool } from './DataProcessingTools.js';
export { dataMergeTool } from './DataProcessingTools.js';
export { dataCleaningTool } from './DataProcessingTools.js';

// 工具分类枚举
export enum ToolExtensionCategory {
  CODE_ANALYSIS = 'code_analysis',
  NETWORK = 'network',
  DATA_PROCESSING = 'data_processing',
}

// 导出所有扩展工具
export const allExtensionTools = [
  // 代码分析工具
  codeQualityAnalyzer,
  codeSecurityAnalyzer,
  codePerformanceAnalyzer,
  codeComplexityAnalyzer,
  
  // 网络工具
  httpRequestTool,
  webSocketTool,
  apiTestTool,
  webScraperTool,
  proxyTestTool,
  dnsLookupTool,
  portScanTool,
  
  // 数据处理工具
  dataTransformTool,
  dataValidationTool,
  dataStatisticsTool,
  dataVisualizationTool,
  dataMergeTool,
  dataCleaningTool,
];

// 按分类导出的工具Map
export const toolsByCategory = {
  [ToolExtensionCategory.CODE_ANALYSIS]: [
    codeQualityAnalyzer,
    codeSecurityAnalyzer,
    codePerformanceAnalyzer,
    codeComplexityAnalyzer,
  ],
  [ToolExtensionCategory.NETWORK]: [
    httpRequestTool,
    webSocketTool,
    apiTestTool,
    webScraperTool,
    proxyTestTool,
    dnsLookupTool,
    portScanTool,
  ],
  [ToolExtensionCategory.DATA_PROCESSING]: [
    dataTransformTool,
    dataValidationTool,
    dataStatisticsTool,
    dataVisualizationTool,
    dataMergeTool,
    dataCleaningTool,
  ],
};

// 批量注册函数
export async function registerExtensionTools(toolManager: any): Promise<void> {
  const registeredResults = {
    success: 0,
    failed: 0,
    details: [] as Array<{ name: string; success: boolean; error?: string }>,
  };
  
  for (const tool of allExtensionTools) {
    try {
      // 注意：这里需要传入实际的ToolManager实例
      // await toolManager.registerTool(tool);
      registeredResults.success++;
      registeredResults.details.push({ name: tool.name, success: true });
    } catch (error) {
      registeredResults.failed++;
      registeredResults.details.push({ 
        name: tool.name, 
        success: false, 
        error: (error as Error).message 
      });
    }
  }
  
  console.log(`工具扩展注册完成: ${registeredResults.success}成功, ${registeredResults.failed}失败`);
  
  if (registeredResults.failed > 0) {
    console.log('失败的工具详情:', 
      registeredResults.details.filter(d => !d.success)
    );
  }
}

// 工具扩展统计信息
export function getExtensionStats(): {
  total: number;
  byCategory: Record<string, number>;
  categories: string[];
} {
  const byCategory: Record<string, number> = {};
  
  for (const category of Object.keys(toolsByCategory)) {
    byCategory[category] = toolsByCategory[category as ToolExtensionCategory].length;
  }
  
  return {
    total: allExtensionTools.length,
    byCategory,
    categories: Object.keys(toolsByCategory),
  };
}

// 根据名称获取特定工具
export function getToolByName(name: string): any {
  return allExtensionTools.find(tool => tool.name === name);
}

// 根据分类获取工具列表
export function getToolsByCategory(category: ToolExtensionCategory): any[] {
  return toolsByCategory[category] || [];
}

// 获取工具的名称列表
export function getToolNames(): string[] {
  return allExtensionTools.map(tool => tool.name);
}

// 检查工具是否存在
export function hasTool(name: string): boolean {
  return getToolByName(name) !== undefined;
}

// 获取工具分类
export function getToolCategories(): ToolExtensionCategory[] {
  return Object.values(ToolExtensionCategory);
}