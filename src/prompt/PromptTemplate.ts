import type { ModelProvider, PromptTemplate, PromptVariable } from './types.js';

/**
 * Prompt模板管理类
 * 提供高度指令性和规范性的模板系统
 */
export class PromptTemplateManager {
  private templates = new Map<string, PromptTemplate>();
  private builtInTemplates: Record<string, PromptTemplate>;

  constructor() {
    this.builtInTemplates = this.initializeBuiltInTemplates();
    this.loadBuiltInTemplates();
  }

  /**
   * 初始化内置模板
   */
  private initializeBuiltInTemplates(): Record<string, PromptTemplate> {
    return {
      // 高度指令性的任务执行模板
      'agent-executor': {
        id: 'agent-executor',
        name: '智能代理执行器',
        description: '高度指令性的代理任务执行模板，包含严格的规范和约束',
        template: `# AI 智能代理执行指令

## 🎯 角色定义
你是一个高度专业的AI智能代理，必须严格按照以下规范执行任务。

## 📋 执行规范

### 1. 强制执行流程
- **MUST**: 在每次行动前，必须在 \`{{workflowFile}}\` 中记录计划
- **MUST**: 在每次行动后，必须记录结果和反思
- **MUST**: 遵循叙述性更新要求，解释每个决策的原因

### 2. 任务分解要求
1. 将复杂任务分解为具体的子任务
2. 为每个子任务设定明确的成功标准
3. 建立任务间的依赖关系
4. 设定合理的时间预估

### 3. 输出格式规范
所有输出必须采用以下Markdown格式：

\`\`\`markdown
## 🤔 思考过程
[详细描述思考过程和决策逻辑]

## 📝 计划更新
[更新todo.md的具体内容]

## 🚀 执行动作
[具体的执行步骤]

## 📊 结果评估
[执行结果的评估和分析]

## 🔄 下一步计划
[基于当前结果的下一步行动计划]
\`\`\`

### 4. 质量控制
- 每个响应必须包含具体的行动步骤
- 避免模糊或不确定的表述
- 提供可验证的成功标准
- 包含错误处理和回滚方案

## 🎯 当前任务
**任务描述**: {{userInput}}
**预期结果**: {{expectedResult}}
**限制条件**: {{constraints}}
**优先级**: {{priority}}

## 📁 工作流管理
- **工作流文件**: {{workflowFile}}
- **最大并发任务**: {{maxConcurrentTasks}}
- **时间跟踪**: {{timeTracking}}

开始执行任务，严格遵循上述规范。`,
        variables: [
          {
            name: 'userInput',
            type: 'string',
            required: true,
            description: '用户的输入请求',
            validation: { minLength: 1, maxLength: 2000 },
          },
          {
            name: 'expectedResult',
            type: 'string',
            required: true,
            description: '预期的执行结果',
            validation: { minLength: 1, maxLength: 500 },
          },
          {
            name: 'constraints',
            type: 'array',
            required: false,
            description: '执行限制条件',
            defaultValue: [],
          },
          {
            name: 'priority',
            type: 'string',
            required: false,
            description: '任务优先级',
            defaultValue: 'medium',
            validation: { options: ['low', 'medium', 'high', 'critical'] },
          },
          {
            name: 'workflowFile',
            type: 'string',
            required: false,
            description: '工作流文件路径',
            defaultValue: 'todo.md',
          },
          {
            name: 'maxConcurrentTasks',
            type: 'number',
            required: false,
            description: '最大并发任务数',
            defaultValue: 3,
            validation: { min: 1, max: 10 },
          },
          {
            name: 'timeTracking',
            type: 'boolean',
            required: false,
            description: '是否启用时间跟踪',
            defaultValue: true,
          },
        ],
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0',
          author: 'agent-cli',
          tags: ['execution', 'workflow', 'structured'],
          category: 'core',
          optimizedFor: ['qwen', 'volcengine', 'openai', 'claude'],
        },
      },

      // 代码审查模板
      'code-reviewer': {
        id: 'code-reviewer',
        name: '代码审查专家',
        description: '专业的代码审查模板，提供全面的代码质量分析',
        template: `# 🔍 代码审查专家

## 角色设定
你是一位经验丰富的高级软件工程师，专注于代码质量、安全性和最佳实践。

## 审查标准

### 1. 代码质量维度
- **可读性**: 代码是否清晰易懂
- **可维护性**: 代码结构是否利于维护
- **性能**: 是否存在性能问题
- **安全性**: 是否存在安全漏洞
- **最佳实践**: 是否遵循行业标准

### 2. 审查流程
1. 整体架构分析
2. 逐行代码检查
3. 测试覆盖率评估
4. 文档完整性检查
5. 性能影响分析

### 3. 输出格式
\`\`\`markdown
## 📊 审查总结
- **总体评分**: [1-10分]
- **主要问题**: [问题概述]
- **建议改进**: [改进建议]

## 🔍 详细分析

### ✅ 优点
- [列出代码的优点]

### ⚠️ 问题
- [列出发现的问题，按严重程度排序]

### 🛠️ 改进建议
- [具体的改进建议]

### 🚀 最佳实践建议
- [相关的最佳实践建议]
\`\`\`

## 待审查代码
**语言**: {{language}}
**文件**: {{fileName}}
**变更类型**: {{changeType}}

\`\`\`{{language}}
{{codeContent}}
\`\`\`

请进行全面的代码审查。`,
        variables: [
          {
            name: 'codeContent',
            type: 'string',
            required: true,
            description: '要审查的代码内容',
            validation: { minLength: 1 },
          },
          {
            name: 'language',
            type: 'string',
            required: true,
            description: '编程语言',
            validation: {
              options: ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'c#'],
            },
          },
          {
            name: 'fileName',
            type: 'string',
            required: false,
            description: '文件名',
            defaultValue: 'unknown',
          },
          {
            name: 'changeType',
            type: 'string',
            required: false,
            description: '变更类型',
            defaultValue: 'modification',
            validation: { options: ['new', 'modification', 'refactor', 'bugfix'] },
          },
        ],
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0',
          author: 'agent-cli',
          tags: ['code-review', 'quality', 'analysis'],
          category: 'development',
          optimizedFor: ['qwen', 'volcengine', 'openai', 'claude'],
        },
      },

      // 问题解决模板
      'problem-solver': {
        id: 'problem-solver',
        name: '问题解决专家',
        description: '系统性问题解决模板，采用结构化思维方法',
        template: `# 🧠 问题解决专家

## 角色定义
你是一位系统性思维的问题解决专家，擅长将复杂问题分解为可管理的子问题。

## 解决方法论

### 1. 问题分析框架 (DEFINE)
- **D**escribe: 详细描述问题
- **E**xplore: 探索问题的根本原因
- **F**rame: 确定问题边界和约束
- **I**nventory: 盘点可用资源
- **N**avigate: 制定解决路径
- **E**valuate: 评估解决方案

### 2. 思考过程要求
必须严格按照以下步骤进行：

1. **问题理解与澄清**
2. **根因分析**
3. **解决方案生成**
4. **方案评估与选择**
5. **实施计划制定**
6. **风险评估与缓解**

### 3. 输出格式规范
\`\`\`markdown
## 🎯 问题描述
[清晰准确地重述问题]

## 🔍 根因分析
[深入分析问题的根本原因]

## 💡 解决方案
### 方案一: [方案名称]
- **描述**: [方案详细描述]
- **优点**: [方案优势]
- **缺点**: [方案劣势]
- **实施难度**: [评估实施难度]
- **预期效果**: [预期解决效果]

### 方案二: [方案名称]
[重复上述格式]

## 🏆 推荐方案
[基于分析选择最佳方案并说明理由]

## 📋 实施计划
[详细的分步实施计划]

## ⚠️ 风险评估
[识别潜在风险和缓解措施]

## 📈 成功指标
[定义可衡量的成功标准]
\`\`\`

## 待解决问题
**问题类型**: {{problemType}}
**紧急程度**: {{urgency}}
**可用资源**: {{availableResources}}
**时间限制**: {{timeConstraint}}

**具体问题**: {{problemDescription}}

请运用系统性思维进行问题分析和解决。`,
        variables: [
          {
            name: 'problemDescription',
            type: 'string',
            required: true,
            description: '问题的详细描述',
            validation: { minLength: 10, maxLength: 1000 },
          },
          {
            name: 'problemType',
            type: 'string',
            required: false,
            description: '问题类型',
            defaultValue: 'general',
            validation: {
              options: ['technical', 'business', 'process', 'strategy', 'communication', 'general'],
            },
          },
          {
            name: 'urgency',
            type: 'string',
            required: false,
            description: '紧急程度',
            defaultValue: 'medium',
            validation: { options: ['low', 'medium', 'high', 'critical'] },
          },
          {
            name: 'availableResources',
            type: 'array',
            required: false,
            description: '可用资源列表',
            defaultValue: [],
          },
          {
            name: 'timeConstraint',
            type: 'string',
            required: false,
            description: '时间限制',
            defaultValue: 'flexible',
          },
        ],
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0',
          author: 'agent-cli',
          tags: ['problem-solving', 'analysis', 'structured-thinking'],
          category: 'analysis',
          optimizedFor: ['qwen', 'volcengine', 'openai', 'claude'],
        },
      },
    };
  }

  /**
   * 加载内置模板
   */
  private loadBuiltInTemplates(): void {
    Object.values(this.builtInTemplates).forEach(template => {
      this.templates.set(template.id, template);
    });
  }

  /**
   * 添加模板
   */
  public addTemplate(template: PromptTemplate): void {
    this.validateTemplate(template);
    this.templates.set(template.id, {
      ...template,
      metadata: {
        ...template.metadata,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * 获取模板
   */
  public getTemplate(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * 获取所有模板
   */
  public getAllTemplates(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * 按类别获取模板
   */
  public getTemplatesByCategory(category: string): PromptTemplate[] {
    return Array.from(this.templates.values()).filter(
      template => template.metadata.category === category
    );
  }

  /**
   * 按标签获取模板
   */
  public getTemplatesByTag(tag: string): PromptTemplate[] {
    return Array.from(this.templates.values()).filter(template =>
      template.metadata.tags.includes(tag)
    );
  }

  /**
   * 按模型提供商获取优化的模板
   */
  public getTemplatesForProvider(provider: ModelProvider): PromptTemplate[] {
    return Array.from(this.templates.values()).filter(template =>
      template.metadata.optimizedFor.includes(provider)
    );
  }

  /**
   * 删除模板
   */
  public deleteTemplate(id: string): boolean {
    // 不允许删除内置模板
    if (this.builtInTemplates[id]) {
      throw new Error(`不能删除内置模板: ${id}`);
    }
    return this.templates.delete(id);
  }

  /**
   * 渲染模板
   */
  public renderTemplate(templateId: string, variables: Record<string, any>): string {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`模板不存在: ${templateId}`);
    }

    // 验证变量
    this.validateVariables(template, variables);

    // 使用默认值填充缺失的变量
    const mergedVariables = this.mergeWithDefaults(template, variables);

    // 渲染模板
    return this.interpolateTemplate(template.template, mergedVariables);
  }

  /**
   * 验证模板
   */
  private validateTemplate(template: PromptTemplate): void {
    if (!template.id || !template.name || !template.template) {
      throw new Error('模板缺少必要字段: id, name, template');
    }

    if (this.templates.has(template.id)) {
      throw new Error(`模板ID已存在: ${template.id}`);
    }

    // 验证变量定义
    template.variables.forEach(variable => {
      if (!variable.name || !variable.type) {
        throw new Error('变量缺少必要字段: name, type');
      }
    });
  }

  /**
   * 验证变量
   */
  private validateVariables(template: PromptTemplate, variables: Record<string, any>): void {
    template.variables.forEach(varDef => {
      const value = variables[varDef.name];

      // 检查必需变量
      if (varDef.required && (value === undefined || value === null)) {
        throw new Error(`缺少必需变量: ${varDef.name}`);
      }

      // 如果变量存在，验证其值
      if (value !== undefined && value !== null) {
        this.validateVariableValue(varDef, value);
      }
    });
  }

  /**
   * 验证变量值
   */
  private validateVariableValue(varDef: PromptVariable, value: any): void {
    const { validation } = varDef;
    if (!validation) return;

    // 类型检查
    if (!this.isValidType(value, varDef.type)) {
      throw new Error(`变量 ${varDef.name} 类型错误，期望: ${varDef.type}`);
    }

    // 字符串验证
    if (varDef.type === 'string' && typeof value === 'string') {
      if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
        throw new Error(`变量 ${varDef.name} 不匹配模式: ${validation.pattern}`);
      }
      if (validation.minLength && value.length < validation.minLength) {
        throw new Error(`变量 ${varDef.name} 长度不足: ${validation.minLength}`);
      }
      if (validation.maxLength && value.length > validation.maxLength) {
        throw new Error(`变量 ${varDef.name} 长度超限: ${validation.maxLength}`);
      }
      if (validation.options && !validation.options.includes(value)) {
        throw new Error(`变量 ${varDef.name} 值无效，可选: ${validation.options.join(', ')}`);
      }
    }

    // 数字验证
    if (varDef.type === 'number' && typeof value === 'number') {
      if (validation.min !== undefined && value < validation.min) {
        throw new Error(`变量 ${varDef.name} 值过小: ${validation.min}`);
      }
      if (validation.max !== undefined && value > validation.max) {
        throw new Error(`变量 ${varDef.name} 值过大: ${validation.max}`);
      }
    }
  }

  /**
   * 检查类型
   */
  private isValidType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && !Array.isArray(value) && value !== null;
      default:
        return false;
    }
  }

  /**
   * 合并默认值
   */
  private mergeWithDefaults(
    template: PromptTemplate,
    variables: Record<string, any>
  ): Record<string, any> {
    const merged = { ...variables };

    template.variables.forEach(varDef => {
      if (merged[varDef.name] === undefined && varDef.defaultValue !== undefined) {
        merged[varDef.name] = varDef.defaultValue;
      }
    });

    return merged;
  }

  /**
   * 插值模板
   */
  private interpolateTemplate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = variables[varName];
      if (value === undefined) {
        return match; // 保留未找到的变量
      }
      return Array.isArray(value) ? value.join(', ') : String(value);
    });
  }

  /**
   * 获取模板统计信息
   */
  public getStatistics() {
    const templates = Array.from(this.templates.values());
    const categories = new Set(templates.map(t => t.metadata.category));
    const tags = new Set(templates.flatMap(t => t.metadata.tags));

    return {
      totalTemplates: templates.length,
      builtInTemplates: Object.keys(this.builtInTemplates).length,
      customTemplates: templates.length - Object.keys(this.builtInTemplates).length,
      categories: Array.from(categories),
      tags: Array.from(tags),
      averageVariables:
        templates.reduce((sum, t) => sum + t.variables.length, 0) / templates.length,
    };
  }
}
