/**
 * Agent架构迁移工具
 * 帮助从旧架构迁移到基于Chat统一调用的新架构
 */

import { Agent } from '../agent/Agent.js';
import { createAgent } from '../agent/index.js';
import type { AgentConfig } from '../agent/types.js';
import type { BladeConfig } from '../config/types/index.js';

export interface MigrationOptions {
  preserveConfiguration: boolean;
  enableNewFeatures: boolean;
  validateCompatibility: boolean;
  backupOldAgent: boolean;
}

export interface MigrationResult {
  success: boolean;
  newAgent?: Agent;
  oldAgent?: Agent;
  issues: string[];
  recommendations: string[];
  performanceComparison?: {
    oldResponseTime: number;
    newResponseTime: number;
    improvement: string;
  };
}

/**
 * Agent迁移器
 */
export class AgentMigrator {
  private config: BladeConfig;
  private options: MigrationOptions;

  constructor(config: BladeConfig, options: Partial<MigrationOptions> = {}) {
    this.config = config;
    this.options = {
      preserveConfiguration: true,
      enableNewFeatures: true,
      validateCompatibility: true,
      backupOldAgent: false,
      ...options,
    };
  }

  /**
   * 执行迁移
   */
  public async migrate(): Promise<MigrationResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let oldAgent: Agent | undefined;
    let newAgent: Agent | undefined;

    try {
      console.log('开始Agent架构迁移...');

      // 1. 创建旧Agent（如果需要备份）
      if (this.options.backupOldAgent) {
        console.log('创建旧Agent备份...');
        // 转换配置格式
        const agentConfig: AgentConfig = this.convertBladeConfigToAgentConfig(this.config);
        oldAgent = new Agent(agentConfig);
        await oldAgent.initialize();
      }

      // 2. 验证配置兼容性
      if (this.options.validateCompatibility) {
        console.log('验证配置兼容性...');
        const compatibilityIssues = this.validateConfiguration();
        issues.push(...compatibilityIssues);
      }

      // 3. 创建新Agent
      console.log('创建新MainAgent...');
      const agentConfig = this.convertBladeConfigToAgentConfig(this.config);
      newAgent = await createAgent(agentConfig);

      // 4. 测试基本功能
      console.log('测试基本功能...');
      const testResult = await this.testBasicFunctionality(newAgent, oldAgent);
      if (!testResult.success) {
        issues.push('基本功能测试失败');
        return {
          success: false,
          issues,
          recommendations: ['请检查配置是否正确', '确保所有依赖已安装'],
        };
      }

      // 5. 生成迁移建议
      recommendations.push(...this.generateRecommendations());

      console.log('Agent架构迁移完成!');

      return {
        success: true,
        newAgent,
        oldAgent,
        issues,
        recommendations,
        performanceComparison: testResult.performanceComparison,
      };
    } catch (error) {
      console.error('Agent迁移失败:', error);

      // 清理资源
      if (newAgent) {
        await newAgent.destroy().catch(console.error);
      }
      if (oldAgent) {
        await oldAgent.destroy().catch(console.error);
      }

      return {
        success: false,
        issues: [...issues, `迁移失败: ${error instanceof Error ? error.message : String(error)}`],
        recommendations: ['请检查错误日志', '确保所有依赖正确安装', '验证配置参数'],
      };
    }
  }

  /**
   * 验证配置兼容性
   */
  private validateConfiguration(): string[] {
    const issues: string[] = [];

    // 检查必要配置
    if (!this.config.apiKey) {
      issues.push('缺少API密钥配置');
    }

    if (!this.config.baseUrl) {
      issues.push('缺少Base URL配置');
    }

    if (!this.config.modelName) {
      issues.push('缺少模型名称配置');
    }

    // 检查新架构特有配置
    const recommendations: string[] = [];
    if (this.options.enableNewFeatures) {
      recommendations.push('建议使用新的AgentConfig配置格式');
      recommendations.push('建议启用上下文压缩功能以优化性能');
    }

    return issues;
  }

  /**
   * 测试基本功能
   */
  private async testBasicFunctionality(
    newAgent: Agent,
    oldAgent?: Agent
  ): Promise<{
    success: boolean;
    performanceComparison?: {
      oldResponseTime: number;
      newResponseTime: number;
      improvement: string;
    };
  }> {
    const testPrompt = '你好，请简单介绍一下你的功能';

    try {
      // 测试新Agent
      const newStart = Date.now();
      const newResponse = await newAgent.chat(testPrompt);
      const newTime = Date.now() - newStart;

      if (!newResponse || newResponse.length < 10) {
        return { success: false };
      }

      // 如果有旧Agent，进行性能对比
      if (oldAgent) {
        const oldStart = Date.now();
        await oldAgent.chat(testPrompt);
        const oldTime = Date.now() - oldStart;

        const improvement =
          oldTime > 0 ? `${(((oldTime - newTime) / oldTime) * 100).toFixed(1)}%` : '无法计算';

        return {
          success: true,
          performanceComparison: {
            oldResponseTime: oldTime,
            newResponseTime: newTime,
            improvement,
          },
        };
      }

      return { success: true };
    } catch (error) {
      console.error('功能测试失败:', error);
      return { success: false };
    }
  }

  /**
   * 生成迁移建议
   */
  private generateRecommendations(): string[] {
    const recommendations: string[] = [];

    recommendations.push('✅ 成功迁移到新架构！');
    recommendations.push('📚 查看 packages/core/src/agent/README.md 了解新功能');
    recommendations.push('🔧 考虑配置专业化的子Agent以提高效率');
    recommendations.push('📊 使用上下文管理功能优化长对话');
    recommendations.push('🚀 尝试AgentTool实现复杂任务的递归处理');

    if (this.options.enableNewFeatures) {
      recommendations.push('⚡ 新功能已启用，可以体验实时Steering和智能任务规划');
    }

    recommendations.push('⚙️ 建议使用新的AgentConfig配置格式以充分利用新架构优势');

    recommendations.push('🧪 在生产环境使用前请进行充分测试');

    return recommendations;
  }

  /**
   * 转换BladeConfig到AgentConfig
   */
  private convertBladeConfigToAgentConfig(bladeConfig: BladeConfig): AgentConfig {
    return {
      chat: {
        provider: 'qwen', // 默认使用qwen
        apiKey: bladeConfig.apiKey,
        baseUrl: bladeConfig.baseUrl,
        model: bladeConfig.modelName,
        temperature: 0.7,
        maxTokens: 4000,
      },
      context: {
        maxTokens: 4000,
        maxMessages: 50,
        compressionEnabled: true,
      },
    };
  }

  /**
   * 生成迁移报告
   */
  public generateMigrationReport(result: MigrationResult): string {
    let report = '# Agent架构迁移报告\n\n';

    report += `## 迁移状态: ${result.success ? '✅ 成功' : '❌ 失败'}\n\n`;

    if (result.issues.length > 0) {
      report += '## 发现的问题\n\n';
      for (const issue of result.issues) {
        report += `- ⚠️ ${issue}\n`;
      }
      report += '\n';
    }

    if (result.recommendations.length > 0) {
      report += '## 建议\n\n';
      for (const rec of result.recommendations) {
        report += `- ${rec}\n`;
      }
      report += '\n';
    }

    if (result.performanceComparison) {
      const perf = result.performanceComparison;
      report += '## 性能对比\n\n';
      report += `- 旧架构响应时间: ${perf.oldResponseTime}ms\n`;
      report += `- 新架构响应时间: ${perf.newResponseTime}ms\n`;
      report += `- 性能改进: ${perf.improvement}\n\n`;
    }

    report += '## 新架构特性\n\n';
    report += '- 🤖 多Agent协作系统\n';
    report += '- 🧠 智能任务规划\n';
    report += '- 🎯 实时Steering调整\n';
    report += '- 💾 智能上下文管理\n';
    report += '- 🔄 递归代理模式\n';
    report += '- ⚡ 性能优化\n\n';

    report += '## 下一步\n\n';
    report += '1. 阅读新架构文档\n';
    report += '2. 逐步迁移现有代码\n';
    report += '3. 配置专业化Agent\n';
    report += '4. 优化上下文策略\n';
    report += '5. 监控性能表现\n';

    return report;
  }
}

/**
 * 快速迁移函数
 */
export async function quickMigrate(config: BladeConfig): Promise<MigrationResult> {
  const migrator = new AgentMigrator(config, {
    preserveConfiguration: true,
    enableNewFeatures: true,
    validateCompatibility: true,
    backupOldAgent: false,
  });

  return await migrator.migrate();
}

/**
 * 完整迁移函数（包含备份）
 */
export async function fullMigrate(config: BladeConfig): Promise<MigrationResult> {
  const migrator = new AgentMigrator(config, {
    preserveConfiguration: true,
    enableNewFeatures: true,
    validateCompatibility: true,
    backupOldAgent: true,
  });

  const result = await migrator.migrate();

  // 生成并打印迁移报告
  const report = migrator.generateMigrationReport(result);
  console.log('\n' + report);

  return result;
}
