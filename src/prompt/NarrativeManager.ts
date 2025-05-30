import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { NarrativeEntry, NarrativeType } from './types.js';

/**
 * 叙述性更新管理器
 * 实现强制叙述性更新，要求Agent在每次行动前后解释其行为和思考
 */
export class NarrativeManager {
  private entries: NarrativeEntry[] = [];
  private workingDirectory: string;
  private narrativeFilePath: string;
  private autoSave: boolean;
  private maxEntries: number;

  constructor(
    workingDirectory: string = process.cwd(),
    options: {
      autoSave?: boolean;
      maxEntries?: number;
      narrativeFile?: string;
    } = {}
  ) {
    this.workingDirectory = workingDirectory;
    this.autoSave = options.autoSave ?? true;
    this.maxEntries = options.maxEntries ?? 1000;
    this.narrativeFilePath = join(workingDirectory, options.narrativeFile ?? 'narrative.md');

    this.loadNarrativeFile();
  }

  /**
   * 加载叙述文件
   */
  private loadNarrativeFile(): void {
    if (!existsSync(this.narrativeFilePath)) {
      this.initializeNarrativeFile();
      return;
    }

    try {
      const content = readFileSync(this.narrativeFilePath, 'utf-8');
      this.parseNarrativeContent(content);
    } catch (error) {
      console.error('加载narrative.md文件失败:', error);
      this.initializeNarrativeFile();
    }
  }

  /**
   * 初始化叙述文件
   */
  private initializeNarrativeFile(): void {
    const initialContent = this.generateNarrativeTemplate();
    writeFileSync(this.narrativeFilePath, initialContent, 'utf-8');
  }

  /**
   * 生成叙述模板
   */
  private generateNarrativeTemplate(): string {
    const timestamp = new Date().toISOString();
    return `# 📖 Agent 叙述性更新日志

> 创建时间: ${timestamp}
> 管理器: Agent CLI Narrative Manager

## 📝 概述

此文档记录Agent的思考过程、决策逻辑和行动结果，确保AI操作的透明度和可追溯性。

## 🎯 叙述性更新规范

### 更新类型

- 🤔 **思考 (Thinking)**: 分析问题和探索解决方案
- 📋 **规划 (Planning)**: 制定具体的行动计划
- 🚀 **行动 (Action)**: 执行具体的操作步骤
- 📊 **结果 (Result)**: 记录行动的结果和影响
- 🔄 **反思 (Reflection)**: 总结经验和改进点
- 🎯 **决策 (Decision)**: 重要的决策点和选择理由

### 强制要求

1. **行动前更新**: 在执行任何重要操作前，必须记录思考和规划过程
2. **行动后更新**: 在完成操作后，必须记录结果和反思
3. **决策说明**: 对于关键决策，必须详细解释选择理由
4. **透明度**: 所有更新必须清晰、具体、可理解

---

## 📚 更新日志

<!-- 更新条目将自动添加到这里 -->

---

*此文件由 Agent CLI 自动维护*
`;
  }

  /**
   * 解析叙述文件内容
   */
  private parseNarrativeContent(content: string): void {
    // 简单的解析实现，实际可以更复杂
    const sections = content.split('---\n');
    if (sections.length > 2) {
      // 解析现有条目的逻辑可以在这里实现
      // 为了简化，这里暂时跳过解析现有条目
    }
  }

  /**
   * 添加叙述性更新
   */
  public addEntry(
    type: NarrativeType,
    content: string,
    context?: Record<string, any>,
    metadata?: {
      taskId?: string;
      actionType?: string;
      severity?: 'info' | 'warning' | 'error' | 'success';
      tags?: string[];
    }
  ): NarrativeEntry {
    const entry: NarrativeEntry = {
      id: this.generateEntryId(),
      type,
      timestamp: new Date(),
      content,
      context,
      metadata: {
        taskId: metadata?.taskId,
        actionType: metadata?.actionType,
        severity: metadata?.severity || 'info',
        tags: metadata?.tags || [],
      },
    };

    this.entries.push(entry);

    // 限制条目数量
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    if (this.autoSave) {
      this.saveNarrativeFile();
    }

    return entry;
  }

  /**
   * 记录思考过程
   */
  public recordThinking(
    thought: string,
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    return this.addEntry(
      'thinking',
      `🤔 **思考过程**

${thought}

**思考要点:**
- 问题分析: ${this.extractAnalysis(thought)}
- 关键考虑: ${this.extractConsiderations(thought)}
- 潜在风险: ${this.extractRisks(thought)}`,
      context,
      { taskId, severity: 'info', tags: ['思考'] }
    );
  }

  /**
   * 记录规划过程
   */
  public recordPlanning(
    plan: string,
    steps: string[],
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    const planningContent = `📋 **规划阶段**

${plan}

**执行步骤:**
${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

**规划考虑:**
- 步骤依赖关系已确认
- 资源需求已评估
- 时间安排合理
- 风险点已识别`;

    return this.addEntry('planning', planningContent, context, {
      taskId,
      severity: 'info',
      tags: ['规划', '执行计划'],
    });
  }

  /**
   * 记录行动过程
   */
  public recordAction(
    action: string,
    details: string,
    expectedOutcome: string,
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    const actionContent = `🚀 **执行行动**

**行动描述:** ${action}

**执行详情:** ${details}

**预期结果:** ${expectedOutcome}

**执行环境:**
- 时间: ${new Date().toLocaleString()}
- 状态: 进行中
- 监控: 已启用`;

    return this.addEntry('action', actionContent, context, {
      taskId,
      actionType: action,
      severity: 'info',
      tags: ['执行', '行动'],
    });
  }

  /**
   * 记录结果
   */
  public recordResult(
    actualOutcome: string,
    success: boolean,
    metrics?: Record<string, any>,
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    const resultContent = `📊 **执行结果**

**实际结果:** ${actualOutcome}

**执行状态:** ${success ? '✅ 成功' : '❌ 失败'}

**性能指标:**
${
  metrics
    ? Object.entries(metrics)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n')
    : '- 无指标数据'
}

**结果分析:**
- 与预期对比: ${success ? '符合预期' : '存在偏差'}
- 影响评估: ${this.assessImpact(success, actualOutcome)}
- 后续建议: ${this.generateRecommendations(success, actualOutcome)}`;

    return this.addEntry('result', resultContent, context, {
      taskId,
      severity: success ? 'success' : 'error',
      tags: ['结果', success ? '成功' : '失败'],
    });
  }

  /**
   * 记录反思
   */
  public recordReflection(
    reflection: string,
    lessons: string[],
    improvements: string[],
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    const reflectionContent = `🔄 **行动反思**

${reflection}

**经验总结:**
${lessons.map((lesson, index) => `${index + 1}. ${lesson}`).join('\n')}

**改进建议:**
${improvements.map((improvement, index) => `${index + 1}. ${improvement}`).join('\n')}

**反思价值:**
- 知识积累: ✓
- 流程优化: ✓  
- 风险防范: ✓
- 能力提升: ✓`;

    return this.addEntry('reflection', reflectionContent, context, {
      taskId,
      severity: 'info',
      tags: ['反思', '改进', '学习'],
    });
  }

  /**
   * 记录重要决策
   */
  public recordDecision(
    decision: string,
    options: { option: string; pros: string[]; cons: string[] }[],
    rationale: string,
    context?: Record<string, any>,
    taskId?: string
  ): NarrativeEntry {
    const decisionContent = `🎯 **重要决策**

**决策内容:** ${decision}

**可选方案:**
${options
  .map(
    (opt, index) => `
**方案 ${index + 1}: ${opt.option}**
- 优点: ${opt.pros.join(', ')}
- 缺点: ${opt.cons.join(', ')}
`
  )
  .join('\n')}

**选择理由:** ${rationale}

**决策依据:**
- 业务价值最大化
- 技术可行性确认
- 风险最小化原则
- 资源合理配置`;

    return this.addEntry('decision', decisionContent, context, {
      taskId,
      severity: 'warning',
      tags: ['决策', '重要', '选择'],
    });
  }

  /**
   * 获取指定类型的条目
   */
  public getEntriesByType(type: NarrativeType): NarrativeEntry[] {
    return this.entries.filter(entry => entry.type === type);
  }

  /**
   * 获取所有叙述条目
   */
  public getEntries(): NarrativeEntry[] {
    return [...this.entries];
  }

  /**
   * 获取指定任务的条目
   */
  public getEntriesByTask(taskId: string): NarrativeEntry[] {
    return this.entries.filter(entry => entry.metadata.taskId === taskId);
  }

  /**
   * 获取最近的条目
   */
  public getRecentEntries(limit: number = 10): NarrativeEntry[] {
    return this.entries.slice(-limit);
  }

  /**
   * 搜索条目
   */
  public searchEntries(query: string): NarrativeEntry[] {
    const lowercaseQuery = query.toLowerCase();
    return this.entries.filter(
      entry =>
        entry.content.toLowerCase().includes(lowercaseQuery) ||
        entry.metadata.tags.some(tag => tag.toLowerCase().includes(lowercaseQuery))
    );
  }

  /**
   * 获取条目统计
   */
  public getStatistics() {
    const typeStats = this.entries.reduce(
      (stats, entry) => {
        stats[entry.type] = (stats[entry.type] || 0) + 1;
        return stats;
      },
      {} as Record<NarrativeType, number>
    );

    const severityStats = this.entries.reduce(
      (stats, entry) => {
        const severity = entry.metadata.severity!;
        stats[severity] = (stats[severity] || 0) + 1;
        return stats;
      },
      {} as Record<string, number>
    );

    return {
      totalEntries: this.entries.length,
      typeBreakdown: typeStats,
      severityBreakdown: severityStats,
      timeRange:
        this.entries.length > 0
          ? {
              earliest: this.entries[0].timestamp,
              latest: this.entries[this.entries.length - 1].timestamp,
            }
          : null,
    };
  }

  /**
   * 生成叙述性报告
   */
  public generateNarrativeReport(taskId?: string): string {
    const relevantEntries = taskId ? this.getEntriesByTask(taskId) : this.entries;

    const stats = this.getStatistics();

    let report = `# 📖 叙述性更新报告

## 📊 总体统计
- 总更新数: ${stats.totalEntries}
- 时间范围: ${stats.timeRange ? `${stats.timeRange.earliest.toLocaleString()} - ${stats.timeRange.latest.toLocaleString()}` : 'N/A'}

## 📈 更新类型分布
${Object.entries(stats.typeBreakdown)
  .map(([type, count]) => `- ${this.getTypeEmoji(type as NarrativeType)} ${type}: ${count}`)
  .join('\n')}

## 🎯 更新详情
`;

    relevantEntries.slice(-20).forEach((entry, index) => {
      report += `
### ${this.getTypeEmoji(entry.type)} ${this.getTypeName(entry.type)} #${index + 1}
**时间:** ${entry.timestamp.toLocaleString()}
**任务:** ${entry.metadata.taskId || 'N/A'}
**标签:** ${entry.metadata.tags.join(', ') || 'N/A'}

${entry.content}

---
`;
    });

    return report;
  }

  /**
   * 保存叙述文件
   */
  public saveNarrativeFile(): void {
    const content = this.generateNarrativeFileContent();
    writeFileSync(this.narrativeFilePath, content, 'utf-8');
  }

  /**
   * 生成叙述文件内容
   */
  private generateNarrativeFileContent(): string {
    const template = this.generateNarrativeTemplate();
    const templateParts = template.split('<!-- 更新条目将自动添加到这里 -->');

    let entriesContent = '';
    this.entries.slice(-50).forEach((entry, index) => {
      entriesContent += `
### ${this.getTypeEmoji(entry.type)} ${this.getTypeName(entry.type)} #${index + 1}

**时间:** ${entry.timestamp.toLocaleString()}  
**严重性:** ${this.getSeverityBadge(entry.metadata.severity!)}  
**任务ID:** ${entry.metadata.taskId || 'N/A'}  
**标签:** ${entry.metadata.tags.join(', ') || 'N/A'}

${entry.content}

---
`;
    });

    return templateParts[0] + entriesContent + (templateParts[1] || '');
  }

  /**
   * 生成条目ID
   */
  private generateEntryId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `entry-${timestamp}-${random}`;
  }

  /**
   * 获取类型表情符号
   */
  private getTypeEmoji(type: NarrativeType): string {
    const emojiMap: Record<NarrativeType, string> = {
      thinking: '🤔',
      planning: '📋',
      action: '🚀',
      result: '📊',
      reflection: '🔄',
      decision: '🎯',
    };
    return emojiMap[type] || '📝';
  }

  /**
   * 获取类型名称
   */
  private getTypeName(type: NarrativeType): string {
    const nameMap: Record<NarrativeType, string> = {
      thinking: '思考过程',
      planning: '规划阶段',
      action: '执行行动',
      result: '执行结果',
      reflection: '行动反思',
      decision: '重要决策',
    };
    return nameMap[type] || type;
  }

  /**
   * 获取严重性徽章
   */
  private getSeverityBadge(severity: string): string {
    const badges = {
      info: '🔵 信息',
      warning: '🟡 警告',
      error: '🔴 错误',
      success: '🟢 成功',
    };
    return badges[severity as keyof typeof badges] || severity;
  }

  /**
   * 提取分析内容
   */
  private extractAnalysis(thought: string): string {
    // 简单的关键词提取，实际可以更智能
    return thought.length > 100 ? thought.substring(0, 100) + '...' : thought;
  }

  /**
   * 提取考虑因素
   */
  private extractConsiderations(thought: string): string {
    // 查找包含"考虑"、"因素"等关键词的句子
    const considerations = thought.match(/[^.。]*[考虑因素需要应该][^.。]*/g);
    return considerations ? considerations.slice(0, 2).join('; ') : '多方面因素';
  }

  /**
   * 提取风险点
   */
  private extractRisks(thought: string): string {
    // 查找包含"风险"、"问题"等关键词的句子
    const risks = thought.match(/[^.。]*[风险问题困难挑战][^.。]*/g);
    return risks ? risks.slice(0, 2).join('; ') : '已识别潜在风险';
  }

  /**
   * 评估影响
   */
  private assessImpact(success: boolean, outcome: string): string {
    if (success) {
      return '正面影响，目标达成';
    } else {
      return '需要评估负面影响，制定补救措施';
    }
  }

  /**
   * 生成建议
   */
  private generateRecommendations(success: boolean, outcome: string): string {
    if (success) {
      return '继续当前策略，扩大成功经验';
    } else {
      return '分析失败原因，调整执行策略';
    }
  }

  /**
   * 清理旧条目
   */
  public cleanup(daysToKeep: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const originalLength = this.entries.length;
    this.entries = this.entries.filter(entry => entry.timestamp > cutoffDate);

    const removedCount = originalLength - this.entries.length;

    if (removedCount > 0 && this.autoSave) {
      this.saveNarrativeFile();
    }

    return removedCount;
  }
}
