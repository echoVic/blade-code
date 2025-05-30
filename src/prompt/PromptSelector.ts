import { ModelOptimizer } from './ModelOptimizer.js';
import { NarrativeManager } from './NarrativeManager.js';
import { PromptTemplateManager } from './PromptTemplate.js';
import { RoleManager } from './RoleManager.js';
import type { ModelProvider, PromptTemplate, Role } from './types.js';
import { WorkflowManager } from './WorkflowManager.js';

/**
 * 任务类型识别结果
 */
interface TaskRecognition {
  type: string;
  confidence: number;
  keywords: string[];
  suggestedTemplate?: string;
  suggestedRole?: string;
  suggestedModel?: ModelProvider;
}

/**
 * 智能Prompt选择器
 * 根据用户输入自动选择合适的模板、角色和优化策略
 */
export class PromptSelector {
  private templateManager: PromptTemplateManager;
  private roleManager: RoleManager;
  private modelOptimizer: ModelOptimizer;
  private narrativeManager: NarrativeManager;
  private workflowManager: WorkflowManager;

  // 任务类型识别规则
  private taskPatterns = new Map<
    string,
    {
      keywords: string[];
      priority: number;
      template: string;
      role: string;
      model: ModelProvider;
      description: string;
    }
  >([
    [
      'code-review',
      {
        keywords: [
          '审查',
          '代码审查',
          '检查代码',
          'review',
          '代码质量',
          '代码分析',
          '优化代码',
          '重构',
        ],
        priority: 10,
        template: 'code-reviewer',
        role: 'senior-developer',
        model: 'qwen',
        description: '代码审查和优化任务',
      },
    ],
    [
      'problem-solving',
      {
        keywords: ['解决', '问题', '方案', '困难', '挑战', '分析', '思考', '建议'],
        priority: 8,
        template: 'problem-solver',
        role: 'system-architect',
        model: 'claude',
        description: '问题分析和解决任务',
      },
    ],
    [
      'product-planning',
      {
        keywords: ['产品', '需求', '功能', '用户', '市场', '规划', '产品设计', '用户体验'],
        priority: 9,
        template: 'agent-executor',
        role: 'product-manager',
        model: 'openai',
        description: '产品规划和需求分析',
      },
    ],
    [
      'data-analysis',
      {
        keywords: ['数据', '分析', '统计', '指标', '报表', '可视化', '趋势'],
        priority: 9,
        template: 'problem-solver',
        role: 'data-analyst',
        model: 'claude',
        description: '数据分析和统计任务',
      },
    ],
    [
      'project-management',
      {
        keywords: ['项目', '管理', '计划', '进度', '团队', '协调', '任务分配'],
        priority: 8,
        template: 'agent-executor',
        role: 'project-manager',
        model: 'qwen',
        description: '项目管理和协调任务',
      },
    ],
    [
      'general-development',
      {
        keywords: ['开发', '编程', '代码', '实现', '程序', '算法', '技术'],
        priority: 7,
        template: 'agent-executor',
        role: 'senior-developer',
        model: 'qwen',
        description: '通用开发任务',
      },
    ],
    [
      'creative-writing',
      {
        keywords: ['创意', '写作', '文案', '内容', '故事', '创作'],
        priority: 6,
        template: 'agent-executor',
        role: 'product-manager',
        model: 'openai',
        description: '创意写作任务',
      },
    ],
  ]);

  constructor() {
    this.templateManager = new PromptTemplateManager();
    this.roleManager = new RoleManager();
    this.modelOptimizer = new ModelOptimizer();
    this.narrativeManager = new NarrativeManager();
    this.workflowManager = new WorkflowManager();
  }

  /**
   * 智能分析用户输入，自动选择最合适的prompt配置
   */
  public async analyzeAndSelectPrompt(
    userInput: string,
    context?: {
      previousMessages?: string[];
      currentTask?: string;
      userPreferences?: {
        preferredRole?: string;
        preferredModel?: ModelProvider;
        detailLevel?: 'brief' | 'detailed' | 'comprehensive';
      };
    }
  ): Promise<{
    recognition: TaskRecognition;
    finalPrompt: string;
    metadata: {
      template: PromptTemplate;
      role: Role;
      model: ModelProvider;
      confidence: number;
      reasoning: string;
    };
  }> {
    console.log('🔍 正在分析用户输入:', userInput);

    // 1. 识别任务类型
    const recognition = this.recognizeTaskType(userInput, context);
    console.log(`📋 识别结果: ${recognition.type} (置信度: ${recognition.confidence}%)`);

    // 2. 选择配置
    const config = this.selectConfiguration(recognition, context);
    console.log(`🎯 选择配置: 模板=${config.template}, 角色=${config.role}, 模型=${config.model}`);

    // 3. 生成最终prompt
    const finalPrompt = await this.generateFinalPrompt(userInput, config, recognition);

    // 4. 记录叙述
    this.narrativeManager.recordThinking(
      `分析用户输入"${userInput}"，识别为${recognition.type}任务，置信度${recognition.confidence}%`,
      { userInput, recognition, config }
    );

    const template = this.templateManager.getTemplate(config.template)!;
    const role = this.roleManager.getRole(config.role)!;

    return {
      recognition,
      finalPrompt,
      metadata: {
        template,
        role,
        model: config.model,
        confidence: recognition.confidence,
        reasoning: this.generateReasoning(recognition, config),
      },
    };
  }

  /**
   * 识别任务类型
   */
  private recognizeTaskType(userInput: string, context?: any): TaskRecognition {
    const input = userInput.toLowerCase();
    const scores = new Map<string, number>();

    // 计算每种任务类型的匹配得分
    for (const [taskType, pattern] of this.taskPatterns) {
      let score = 0;
      const matchedKeywords: string[] = [];

      for (const keyword of pattern.keywords) {
        if (input.includes(keyword.toLowerCase())) {
          score += pattern.priority;
          matchedKeywords.push(keyword);
        }
      }

      // 考虑上下文加权
      if (context?.currentTask && context.currentTask.includes(taskType)) {
        score += 5;
      }

      if (score > 0) {
        scores.set(taskType, score);
      }
    }

    // 找到最高分的任务类型
    let bestMatch = { type: 'general-development', score: 0, keywords: [] as string[] };

    for (const [taskType, score] of scores) {
      if (score > bestMatch.score) {
        const pattern = this.taskPatterns.get(taskType)!;
        bestMatch = {
          type: taskType,
          score,
          keywords: pattern.keywords.filter(k => input.includes(k.toLowerCase())),
        };
      }
    }

    // 计算置信度 (0-100)
    const maxPossibleScore = Math.max(
      ...Array.from(this.taskPatterns.values()).map(p => p.priority * 3)
    );
    const confidence = Math.min(100, Math.round((bestMatch.score / maxPossibleScore) * 100));

    const selectedPattern = this.taskPatterns.get(bestMatch.type)!;

    return {
      type: bestMatch.type,
      confidence,
      keywords: bestMatch.keywords,
      suggestedTemplate: selectedPattern.template,
      suggestedRole: selectedPattern.role,
      suggestedModel: selectedPattern.model,
    };
  }

  /**
   * 选择配置
   */
  private selectConfiguration(recognition: TaskRecognition, context?: any) {
    const pattern = this.taskPatterns.get(recognition.type)!;

    return {
      template: context?.userPreferences?.preferredRole
        ? this.findBestTemplateForRole(context.userPreferences.preferredRole)
        : pattern.template,
      role: context?.userPreferences?.preferredRole || pattern.role,
      model: context?.userPreferences?.preferredModel || pattern.model,
    };
  }

  /**
   * 为指定角色找到最佳模板
   */
  private findBestTemplateForRole(roleId: string): string {
    const roleTemplateMapping: Record<string, string> = {
      'senior-developer': 'code-reviewer',
      'product-manager': 'agent-executor',
      'project-manager': 'agent-executor',
      'data-analyst': 'problem-solver',
      'system-architect': 'problem-solver',
    };

    return roleTemplateMapping[roleId] || 'agent-executor';
  }

  /**
   * 生成最终prompt
   */
  private async generateFinalPrompt(
    userInput: string,
    config: { template: string; role: string; model: ModelProvider },
    recognition: TaskRecognition
  ): Promise<string> {
    // 1. 渲染模板
    let templateVariables: Record<string, any> = {};

    // 根据不同模板类型准备变量
    switch (config.template) {
      case 'code-reviewer':
        templateVariables = {
          codeContent: this.extractCodeFromInput(userInput) || '// 待审查的代码',
          language: this.detectLanguage(userInput),
          fileName: 'unknown',
          changeType: 'modification',
        };
        break;
      case 'problem-solver':
        templateVariables = {
          problemDescription: userInput,
          problemType: this.mapTaskTypeToCategory(recognition.type),
          urgency: this.detectUrgency(userInput),
          availableResources: [],
          timeConstraint: 'flexible',
        };
        break;
      case 'agent-executor':
        templateVariables = {
          userInput: userInput,
          expectedResult: this.generateExpectedResult(userInput, recognition),
          constraints: [],
          priority: this.detectUrgency(userInput),
          workflowFile: 'todo.md',
          maxConcurrentTasks: 3,
          timeTracking: true,
        };
        break;
    }

    const basePrompt = this.templateManager.renderTemplate(config.template, templateVariables);

    // 2. 角色适配
    const rolePrompt = this.roleManager.getAdaptedPrompt(basePrompt, config.role);

    // 3. 模型优化
    const finalPrompt = this.modelOptimizer.optimizePrompt(rolePrompt, config.model);

    return finalPrompt;
  }

  /**
   * 从输入中提取代码
   */
  private extractCodeFromInput(input: string): string | null {
    // 查找代码块
    const codeBlockMatch = input.match(/```[\s\S]*?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[0].replace(/```\w*\n?/, '').replace(/```$/, '');
    }

    // 查找行内代码
    const inlineCodeMatch = input.match(/`([^`]+)`/);
    if (inlineCodeMatch) {
      return inlineCodeMatch[1];
    }

    return null;
  }

  /**
   * 检测编程语言
   */
  private detectLanguage(input: string): string {
    const languageKeywords = {
      javascript: ['function', 'const', 'let', 'var', '=>', 'console.log'],
      typescript: ['interface', 'type', 'function', 'const', '=>'],
      python: ['def', 'import', 'from', 'class', 'if __name__'],
      java: ['public', 'class', 'void', 'static', 'import'],
      go: ['func', 'package', 'import', 'var', 'type'],
      rust: ['fn', 'let', 'mut', 'impl', 'struct'],
    };

    const lowerInput = input.toLowerCase();

    for (const [lang, keywords] of Object.entries(languageKeywords)) {
      if (keywords.some(keyword => lowerInput.includes(keyword))) {
        return lang;
      }
    }

    return 'javascript'; // 默认
  }

  /**
   * 检测紧急程度
   */
  private detectUrgency(input: string): 'low' | 'medium' | 'high' | 'critical' {
    const urgentKeywords = ['紧急', '急', '马上', '立即', '尽快', 'urgent', 'asap'];
    const highKeywords = ['重要', '优先', 'important', 'priority'];

    const lowerInput = input.toLowerCase();

    if (urgentKeywords.some(keyword => lowerInput.includes(keyword))) {
      return 'critical';
    }
    if (highKeywords.some(keyword => lowerInput.includes(keyword))) {
      return 'high';
    }

    return 'medium';
  }

  /**
   * 映射任务类型到问题类别
   */
  private mapTaskTypeToCategory(taskType: string): string {
    const mapping: Record<string, string> = {
      'code-review': 'technical',
      'problem-solving': 'general',
      'product-planning': 'business',
      'data-analysis': 'technical',
      'project-management': 'process',
      'general-development': 'technical',
      'creative-writing': 'strategy',
    };

    return mapping[taskType] || 'general';
  }

  /**
   * 生成预期结果
   */
  private generateExpectedResult(userInput: string, recognition: TaskRecognition): string {
    const resultTemplates: Record<string, string> = {
      'code-review': '提供详细的代码质量分析报告，包含问题识别和改进建议',
      'problem-solving': '提供系统性的问题分析和具体的解决方案',
      'product-planning': '提供完整的产品规划方案和实施建议',
      'data-analysis': '提供数据分析结果和业务洞察',
      'project-management': '提供项目管理方案和执行计划',
      'general-development': '提供高质量的代码实现和技术方案',
      'creative-writing': '提供创意内容和写作建议',
    };

    return resultTemplates[recognition.type] || '提供准确、有用的回答和建议';
  }

  /**
   * 生成选择理由
   */
  private generateReasoning(recognition: TaskRecognition, config: any): string {
    const pattern = this.taskPatterns.get(recognition.type)!;

    return `基于关键词匹配 [${recognition.keywords.join(', ')}]，识别为${pattern.description}。
选择${config.role}角色确保专业性，使用${config.template}模板提供结构化输出，
针对${config.model}模型优化以获得最佳效果。置信度: ${recognition.confidence}%`;
  }

  /**
   * 快速智能回复 - 一键生成最佳prompt
   */
  public async smartReply(userInput: string): Promise<string> {
    const result = await this.analyzeAndSelectPrompt(userInput);

    console.log('\n🤖 智能prompt已生成:');
    console.log(`📊 任务类型: ${result.recognition.type}`);
    console.log(`🎭 选择角色: ${result.metadata.role.name}`);
    console.log(`📋 使用模板: ${result.metadata.template.name}`);
    console.log(`🚀 优化模型: ${result.metadata.model}`);
    console.log(`📈 置信度: ${result.metadata.confidence}%`);
    console.log(`💡 选择理由: ${result.metadata.reasoning}`);

    return result.finalPrompt;
  }

  /**
   * 获取支持的任务类型
   */
  public getSupportedTaskTypes(): Array<{
    type: string;
    description: string;
    keywords: string[];
    examples: string[];
  }> {
    return Array.from(this.taskPatterns.entries()).map(([type, pattern]) => ({
      type,
      description: pattern.description,
      keywords: pattern.keywords.slice(0, 5),
      examples: this.generateExamples(type),
    }));
  }

  /**
   * 生成示例
   */
  private generateExamples(taskType: string): string[] {
    const examples: Record<string, string[]> = {
      'code-review': [
        '帮我审查这段JavaScript代码',
        '检查一下这个函数的性能问题',
        '这段代码有什么可以优化的地方？',
      ],
      'problem-solving': [
        '我遇到了一个技术难题，需要帮助分析',
        '如何解决系统性能瓶颈问题？',
        '项目进度延期了，有什么好的解决方案？',
      ],
      'product-planning': [
        '我需要设计一个新的产品功能',
        '如何改进用户体验？',
        '分析一下这个产品需求的可行性',
      ],
      'data-analysis': [
        '帮我分析这组销售数据',
        '如何解读这个用户行为趋势？',
        '需要制作一个数据报表',
      ],
    };

    return examples[taskType] || ['通用任务示例'];
  }
}
