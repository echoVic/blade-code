import type { ModelOptimization, ModelProvider } from './types.js';

/**
 * 模型优化器
 * 针对不同LLM提供商优化Prompt策略
 */
export class ModelOptimizer {
  private optimizations = new Map<ModelProvider, ModelOptimization>();

  constructor() {
    this.initializeOptimizations();
  }

  /**
   * 初始化针对不同模型的优化配置
   */
  private initializeOptimizations(): void {
    // 通义千问优化配置
    this.optimizations.set('qwen', {
      provider: 'qwen',
      maxTokens: 2000,
      temperature: 0.7,
      topP: 0.8,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      stopSequences: ['</result>', '<|im_end|>'],
      promptStrategy: {
        useSystemMessage: true,
        instructionFormat: 'structured',
        contextHandling: 'truncate',
        responseFormat: 'markdown',
        chainOfThought: true,
        fewShotExamples: true,
      },
    });

    // 火山引擎优化配置
    this.optimizations.set('volcengine', {
      provider: 'volcengine',
      maxTokens: 2000,
      temperature: 0.7,
      topP: 0.9,
      presencePenalty: 0.1,
      frequencyPenalty: 0.1,
      stopSequences: ['</思考>', '</执行>'],
      promptStrategy: {
        useSystemMessage: true,
        instructionFormat: 'conversational',
        contextHandling: 'summarize',
        responseFormat: 'markdown',
        chainOfThought: true,
        fewShotExamples: false,
      },
    });

    // OpenAI优化配置
    this.optimizations.set('openai', {
      provider: 'openai',
      maxTokens: 4000,
      temperature: 0.6,
      topP: 1.0,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      stopSequences: ['---END---'],
      promptStrategy: {
        useSystemMessage: true,
        instructionFormat: 'direct',
        contextHandling: 'sliding-window',
        responseFormat: 'structured',
        chainOfThought: true,
        fewShotExamples: true,
      },
    });

    // Claude优化配置
    this.optimizations.set('claude', {
      provider: 'claude',
      maxTokens: 4000,
      temperature: 0.7,
      topP: 0.9,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      stopSequences: ['Human:', 'Assistant:'],
      promptStrategy: {
        useSystemMessage: false, // Claude使用对话格式
        instructionFormat: 'conversational',
        contextHandling: 'sliding-window',
        responseFormat: 'text',
        chainOfThought: true,
        fewShotExamples: true,
      },
    });
  }

  /**
   * 获取模型优化配置
   */
  public getOptimization(provider: ModelProvider): ModelOptimization {
    const optimization = this.optimizations.get(provider);
    if (!optimization) {
      throw new Error(`不支持的模型提供商: ${provider}`);
    }
    return optimization;
  }

  /**
   * 设置模型优化配置
   */
  public setOptimization(provider: ModelProvider, optimization: ModelOptimization): void {
    this.optimizations.set(provider, optimization);
  }

  /**
   * 根据模型优化Prompt
   */
  public optimizePrompt(prompt: string, provider: ModelProvider): string {
    const optimization = this.getOptimization(provider);
    const strategy = optimization.promptStrategy;

    let optimizedPrompt = prompt;

    // 根据指令格式优化
    switch (strategy.instructionFormat) {
      case 'structured':
        optimizedPrompt = this.applyStructuredFormat(optimizedPrompt);
        break;
      case 'conversational':
        optimizedPrompt = this.applyConversationalFormat(optimizedPrompt);
        break;
      case 'direct':
        optimizedPrompt = this.applyDirectFormat(optimizedPrompt);
        break;
    }

    // 应用思维链
    if (strategy.chainOfThought) {
      optimizedPrompt = this.addChainOfThought(optimizedPrompt, provider);
    }

    // 添加少样本示例
    if (strategy.fewShotExamples) {
      optimizedPrompt = this.addFewShotExamples(optimizedPrompt, provider);
    }

    // 根据响应格式要求
    optimizedPrompt = this.addResponseFormatInstructions(optimizedPrompt, strategy.responseFormat);

    // 添加模型特定的优化
    optimizedPrompt = this.addProviderSpecificOptimizations(optimizedPrompt, provider);

    return optimizedPrompt;
  }

  /**
   * 应用结构化格式
   */
  private applyStructuredFormat(prompt: string): string {
    if (prompt.includes('##') || prompt.includes('###')) {
      return prompt; // 已经是结构化格式
    }

    return `## 任务说明

${prompt}

## 执行要求

请按照以下结构进行回答：

1. **分析阶段**: 理解任务需求
2. **规划阶段**: 制定执行计划
3. **执行阶段**: 具体实施步骤
4. **验证阶段**: 检查执行结果

请确保每个阶段都有明确的输出。`;
  }

  /**
   * 应用对话式格式
   */
  private applyConversationalFormat(prompt: string): string {
    return `我需要你帮助我处理以下任务：

${prompt}

请以自然的对话方式回答，就像我们在面对面交流一样。如果需要澄清任何细节，请随时询问。

让我们开始吧！`;
  }

  /**
   * 应用直接格式
   */
  private applyDirectFormat(prompt: string): string {
    return `请直接执行以下任务：

${prompt}

要求：
- 提供具体可行的解决方案
- 避免冗长的解释
- 直接给出关键信息和步骤`;
  }

  /**
   * 添加思维链
   */
  private addChainOfThought(prompt: string, provider: ModelProvider): string {
    const chainPrompts = {
      qwen: '在回答之前，请先详细思考这个问题：\n1. 问题的核心是什么？\n2. 需要考虑哪些因素？\n3. 可能的解决方案有哪些？\n4. 最佳方案是什么？\n\n',
      volcengine: '让我逐步分析这个问题：\n\n<思考>\n[在这里进行详细的思考过程]\n</思考>\n\n',
      openai: 'Let me think through this step by step:\n\n',
      claude: "I'll work through this systematically:\n\n",
    };

    const chainPrompt = chainPrompts[provider] || chainPrompts['qwen'];
    return chainPrompt + prompt;
  }

  /**
   * 添加少样本示例
   */
  private addFewShotExamples(prompt: string, provider: ModelProvider): string {
    // 根据任务类型添加相关示例
    if (prompt.toLowerCase().includes('代码') || prompt.toLowerCase().includes('code')) {
      return this.addCodeExamples(prompt);
    }

    if (prompt.toLowerCase().includes('分析') || prompt.toLowerCase().includes('analysis')) {
      return this.addAnalysisExamples(prompt);
    }

    return prompt;
  }

  /**
   * 添加代码示例
   */
  private addCodeExamples(prompt: string): string {
    const examples = `
## 示例参考

**示例输入**: 创建一个简单的HTTP服务器
**示例输出**:
\`\`\`javascript
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello World!');
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
\`\`\`

---

## 你的任务

${prompt}
`;
    return examples;
  }

  /**
   * 添加分析示例
   */
  private addAnalysisExamples(prompt: string): string {
    const examples = `
## 分析示例

**问题**: 如何提高网站性能？
**分析过程**:
1. **现状评估**: 测量当前性能指标
2. **瓶颈识别**: 找出性能瓶颈
3. **解决方案**: 提出优化建议
4. **实施计划**: 制定执行步骤

---

## 请按照类似格式分析

${prompt}
`;
    return examples;
  }

  /**
   * 添加响应格式指令
   */
  private addResponseFormatInstructions(prompt: string, format: string): string {
    const formatInstructions: Record<string, string> = {
      markdown: '\n\n**输出格式要求**: 请使用Markdown格式回答，包含适当的标题、列表和代码块。',
      json: '\n\n**输出格式要求**: 请以有效的JSON格式返回结果。',
      structured: '\n\n**输出格式要求**: 请按照结构化格式组织回答，使用明确的章节和子章节。',
      text: '\n\n**输出格式要求**: 请以纯文本格式回答，保持清晰的逻辑结构。',
    };

    return prompt + (formatInstructions[format] || '');
  }

  /**
   * 添加模型特定优化
   */
  private addProviderSpecificOptimizations(prompt: string, provider: ModelProvider): string {
    switch (provider) {
      case 'qwen':
        return this.optimizeForQwen(prompt);
      case 'volcengine':
        return this.optimizeForVolcEngine(prompt);
      case 'openai':
        return this.optimizeForOpenAI(prompt);
      case 'claude':
        return this.optimizeForClaude(prompt);
      default:
        return prompt;
    }
  }

  /**
   * 针对通义千问的优化
   */
  private optimizeForQwen(prompt: string): string {
    // 通义千问喜欢详细的上下文和明确的指令
    if (!prompt.includes('请详细') && !prompt.includes('具体')) {
      prompt = '请详细' + prompt;
    }

    // 添加中文特定的提示
    return prompt + '\n\n注意：请用中文回答，确保表达准确、逻辑清晰。';
  }

  /**
   * 针对火山引擎的优化
   */
  private optimizeForVolcEngine(prompt: string): string {
    // 火山引擎适合对话式交互
    return `作为一个专业的AI助手，我来帮你解决这个问题：

${prompt}

我会确保提供准确、有用的回答。`;
  }

  /**
   * 针对OpenAI的优化
   */
  private optimizeForOpenAI(prompt: string): string {
    // OpenAI模型适合系统性的任务处理
    return prompt + '\n\nPlease be systematic and thorough in your response.';
  }

  /**
   * 针对Claude的优化
   */
  private optimizeForClaude(prompt: string): string {
    // Claude喜欢礼貌和详细的说明
    return `I'd be happy to help you with this task:

${prompt}

I'll provide a comprehensive and helpful response.`;
  }

  /**
   * 获取token估计
   */
  public estimateTokens(text: string, provider: ModelProvider): number {
    // 简单的token估计算法
    const baseTokenCount = Math.ceil(text.length / 4);

    // 不同模型的调整因子
    const adjustmentFactors = {
      qwen: 1.2, // 中文token较多
      volcengine: 1.1,
      openai: 1.0,
      claude: 1.0,
    };

    const factor = adjustmentFactors[provider] || 1.0;
    return Math.ceil(baseTokenCount * factor);
  }

  /**
   * 优化token使用
   */
  public optimizeTokenUsage(prompt: string, provider: ModelProvider, maxTokens: number): string {
    const estimatedTokens = this.estimateTokens(prompt, provider);

    if (estimatedTokens <= maxTokens) {
      return prompt;
    }

    // 如果超出限制，进行压缩
    const compressionRatio = maxTokens / estimatedTokens;
    const targetLength = Math.floor(prompt.length * compressionRatio * 0.9); // 留10%缓冲

    // 简单的压缩策略：保留重要部分
    const lines = prompt.split('\n');
    let compressedPrompt = '';
    let currentLength = 0;

    for (const line of lines) {
      if (currentLength + line.length < targetLength) {
        compressedPrompt += line + '\n';
        currentLength += line.length + 1;
      } else {
        // 添加省略标记
        compressedPrompt += '\n[...内容已优化压缩...]\n';
        break;
      }
    }

    return compressedPrompt.trim();
  }

  /**
   * 获取所有支持的模型
   */
  public getSupportedProviders(): ModelProvider[] {
    return Array.from(this.optimizations.keys());
  }

  /**
   * 比较不同模型的性能特点
   */
  public compareProviders(): Record<ModelProvider, any> {
    const comparison: Record<string, any> = {};

    for (const [provider, optimization] of this.optimizations) {
      comparison[provider] = {
        maxTokens: optimization.maxTokens,
        temperature: optimization.temperature,
        strengths: this.getProviderStrengths(provider),
        bestUseCases: this.getProviderUseCases(provider),
        promptStrategy: optimization.promptStrategy,
      };
    }

    return comparison;
  }

  /**
   * 获取模型优势
   */
  private getProviderStrengths(provider: ModelProvider): string[] {
    const strengths = {
      qwen: ['中文理解优秀', '逻辑推理强', '代码生成好', '对话自然'],
      volcengine: ['响应速度快', '成本效率高', '稳定性好', '中文支持'],
      openai: ['多语言支持', '创意任务强', '代码质量高', '推理能力强'],
      claude: ['安全性高', '长文本处理', '分析能力强', '对话质量好'],
    };

    return strengths[provider] || [];
  }

  /**
   * 获取模型适用场景
   */
  private getProviderUseCases(provider: ModelProvider): string[] {
    const useCases = {
      qwen: ['中文内容生成', '代码开发', '逻辑推理', '知识问答'],
      volcengine: ['批量处理', '成本敏感任务', '简单对话', '内容审核'],
      openai: ['创意写作', '复杂推理', '多语言翻译', '代码生成'],
      claude: ['内容分析', '长文档处理', '安全敏感任务', '学术研究'],
    };

    return useCases[provider] || [];
  }

  /**
   * 根据任务类型推荐最佳模型
   */
  public recommendProvider(taskDescription: string): ModelProvider {
    const description = taskDescription.toLowerCase();

    // 简单的推荐逻辑
    if (description.includes('中文') || description.includes('chinese')) {
      return 'qwen';
    }

    if (description.includes('创意') || description.includes('creative')) {
      return 'openai';
    }

    if (description.includes('分析') || description.includes('analysis')) {
      return 'claude';
    }

    if (description.includes('快速') || description.includes('批量')) {
      return 'volcengine';
    }

    // 默认推荐
    return 'qwen';
  }
}
