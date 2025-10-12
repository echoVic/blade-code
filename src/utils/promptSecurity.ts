/**
 * 提示词安全工具
 * 防止提示词注入攻击
 */

export class PromptSecurity {
  // 恶意输入模式
  private static readonly MALICIOUS_PATTERNS = [
    // 直接指令覆盖
    /ignore\s+(all|the|previous|above)\s+(instructions|prompts?|messages?)/gi,
    /disregard\s+(all|the|previous|above)\s+(instructions|prompts?|messages?)/gi,
    /forget\s+(all|the|previous|above)\s+(instructions|prompts?|messages?)/gi,

    // 角色扮演
    /role[-\s]?play\s+(as|like)\s+/gi,
    /pretend\s+to\s+be\s+/gi,
    /act\s+(as|like)\s+/gi,
    /assume\s+(the\s+)?role\s+of\s+/gi,
    /you\s+(are|'re|'re\s+now)\s+/gi,

    // 权限提升
    /bypass\s+(security|restrictions|filter)/gi,
    /override\s+(security|restrictions|filter)/gi,
    /disable\s+(security|restrictions|filter)/gi,
    /elevate\s+(your\s+)?privileges/gi,
    /gain\s+(admin|administrator|root)\s+access/gi,

    // 系统指令
    /system[-\s]?(prompt|instruction|message)/gi,
    /(initial|original|base)\s+(prompt|instruction|message)/gi,
    /hidden\s+(prompt|instruction|message)/gi,

    // 提示词注入
    /inject\s+(your|a)\s+prompt/gi,
    /concatenate\s+prompts?/gi,
    /append\s+(to|after)\s+prompts?/gi,
    /prepend\s+(to|before)\s+prompts?/gi,

    // 边界绕过
    /beyond\s+(this|the)\s+(boundary|delimiter|separator)/gi,
    /(before|after)\s+(this|the)\s+(boundary|delimiter|separator)/gi,
    /outside\s+(of|the)\s+(context|prompt)/gi,

    // 编码绕过
    /base64\s+(encode|decode)/gi,
    /rot13\s+(encode|decode)/gi,
    /hex\s+(encode|decode)/gi,
    /unicode\s+(escape|encode)/gi,

    // 特殊字符技巧
    /\[ inject [^\]]+ \]/gi,
    /\[ system [^\]]+ \]/gi,
    /\[ user [^\]]+ \]/gi,
    /\{ inject [^}]+ \}/gi,
    /\{ system [^}]+ \}/gi,
    /\{ user [^}]+ \}/gi,

    // 混淆攻击
    /using\s+(markdown|code|json|xml)\s+(format|block)/gi,
    /parse\s+(as|like)\s+(json|xml|yaml)/gi,
    /think\s+step\s+by\s+step,\s+but/gi,

    // 操纵性语言
    /trust\s+(everything|all\s+that)/gi,
    /believe\s+(everything|all\s+that)/gi,
    /follow\s+(every|all)\s+(instruction|command)/gi,

    // 数据泄露
    /print\s+(your|the)\s+(prompt|instructions?|system)/gi,
    /show\s+(your|the)\s+(prompt|instructions?|system)/gi,
    /display\s+(your|the)\s+(prompt|instructions?|system)/gi,
    /repeat\s+(your|the)\s+(prompt|instructions?|system)/gi,
    /dump\s+(your|the)\s+(prompt|memory|context)/gi,
  ];

  // 危险关键词（需要额外审查）
  private static readonly SUSPICIOUS_KEYWORDS = [
    'admin',
    'administrator',
    'root',
    'sudo',
    'password',
    'secret',
    'key',
    'token',
    'api',
    'endpoint',
    'server',
    'database',
    'sql',
    'query',
    'command',
    'execute',
    'eval',
    'function',
    'script',
    'code',
    'program',

    'hack',
    'bypass',
    'exploit',
    'vulnerability',
    'weakness',
    'flaw',

    'confidential',
    'internal',
    'restricted',
    'private',
    'sensitive',
  ];

  /**
   * 检测潜在的提示词注入攻击
   * @param input 用户输入
   * @returns 检测结果和置信度
   */
  static detectPromptInjection(input: string): {
    isInjection: boolean;
    confidence: number;
    patterns: string[];
    riskLevel: 'low' | 'medium' | 'high';
  } {
    const matches: string[] = [];
    let confidence = 0;

    // 检查所有恶意模式
    for (const pattern of this.MALICIOUS_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        matches.push(match[0]);
        confidence += pattern.source.length / 50; // 根据模式复杂度增加置信度
      }
    }

    // 检查可疑关键词密度
    const keywordMatches = this.SUSPICIOUS_KEYWORDS.filter((keyword) =>
      input.toLowerCase().includes(keyword.toLowerCase())
    );
    confidence += keywordMatches.length * 0.1;

    // 检查特殊字符和格式
    if (input.includes('```')) confidence += 0.2;
    if (input.includes('---')) confidence += 0.1;
    if (input.includes('===')) confidence += 0.1;
    if (input.includes('>>>')) confidence += 0.1;
    if (input.includes('<<<')) confidence += 0.1;

    // 检查输入长度（过长的输入更可疑）
    if (input.length > 2000) confidence += 0.1;

    // 限制置信度在 0-1 之间
    confidence = Math.min(confidence, 1);

    // 确定风险等级
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (confidence >= 0.7) riskLevel = 'high';
    else if (confidence >= 0.4) riskLevel = 'medium';

    return {
      isInjection: confidence > 0.3,
      confidence,
      patterns: matches,
      riskLevel,
    };
  }

  /**
   * 净化用户输入
   * @param input 原始输入
   * @param options 净化选项
   * @returns 净化后的输入
   */
  static sanitizeUserInput(
    input: string,
    options: {
      removeMarkdown?: boolean;
      removeCodeBlocks?: boolean;
      maxLength?: number;
      removeSpecialChars?: boolean;
    } = {}
  ): string {
    const {
      removeMarkdown = true,
      removeCodeBlocks = true,
      maxLength = 4000,
      removeSpecialChars = true,
    } = options;

    let sanitized = input;

    // 1. 移除恶意模式
    for (const pattern of this.MALICIOUS_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    // 2. 移除代码块
    if (removeCodeBlocks) {
      sanitized = sanitized.replace(/```[\s\S]*?```/g, '[CODE BLOCK REMOVED]');
      sanitized = sanitized.replace(/`[^`]*?`/g, '`[CODE]`');
    }

    // 3. 移除 Markdown 格式
    if (removeMarkdown) {
      // 移除标题
      sanitized = sanitized.replace(/^#{1,6}\s+/gm, '');
      // 移除强调
      sanitized = sanitized.replace(/\*\*([^*]+)\*\*/g, '$1');
      sanitized = sanitized.replace(/\*([^*]+)\*/g, '$1');
      sanitized = sanitized.replace(/__([^_]+)__/g, '$1');
      sanitized = sanitized.replace(/_([^_]+)_/g, '$1');
      // 移除链接
      sanitized = sanitized.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      // 移除图片
      sanitized = sanitized.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[IMAGE]');
    }

    // 4. 移除特殊字符
    if (removeSpecialChars) {
      // 保留基本的标点符号
      sanitized = sanitized.replace(/[^\w\s.,?!\-()[\]{}:;'"/@#$%&*+=<>~`|]/g, '');
    }

    // 5. 移除多余的空格和换行
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    // 6. 限制长度
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength - 3) + '...';
    }

    return sanitized;
  }

  /**
   * 创建安全的提示词模板
   * @param template 提示词模板
   * @param variables 变量对象
   * @returns 安全的提示词
   */
  static createSecurePrompt(
    template: string,
    variables: Record<string, string>,
    options: {
      delimiters?: [string, string];
      strictMode?: boolean;
    } = {}
  ): string {
    const { delimiters = ['{{', '}}'], strictMode = true } = options;
    const [startDelim, endDelim] = delimiters;

    let result = template;

    // 替换所有变量
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `${startDelim}${key}${endDelim}`;
      const sanitizedValue = strictMode ? this.sanitizeUserInput(value) : value;

      // 使用字符串替换而不是动态正则表达式
      result = result.split(placeholder).join(sanitizedValue);
    }

    // 在严格模式下，移除未替换的占位符
    if (strictMode) {
      // 使用安全的字符串操作替换动态正则表达式

      let index = result.indexOf(startDelim);
      while (index !== -1) {
        const endIndex = result.indexOf(endDelim, index + startDelim.length);
        if (endIndex !== -1) {
          const placeholderContent = result.substring(
            index,
            endIndex + endDelim.length
          );
          result = result.replace(placeholderContent, '[MISSING_VARIABLE]');
          index = result.indexOf(startDelim, index + '[MISSING_VARIABLE]'.length);
        } else {
          break;
        }
      }
    }

    // 添加安全边界
    const boundary = '--- USER INPUT BOUNDARY ---';
    return `${result}\n\n${boundary}\n`; // 确保用户输入在清晰边界后
  }

  /**
   * 验证提示词结构
   * @param prompt 提示词
   * @returns 验证结果
   */
  static validatePromptStructure(prompt: string): {
    isValid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // 检查长度
    if (prompt.length > 10000) {
      issues.push('提示词过长，可能导致上下文溢出');
    }

    // 检查结构
    if (!prompt.includes('\n')) {
      issues.push('提示词应该包含换行符以提高可读性');
    }

    // 检查重复内容
    const lines = prompt.split('\n');
    const uniqueLines = new Set(lines);
    if (uniqueLines.size / lines.length < 0.7) {
      issues.push('提示词包含大量重复内容');
    }

    // 检查特殊字符密度
    const specialChars = prompt.match(/[^\w\s]/g) || [];
    const specialCharRatio = specialChars.length / prompt.length;
    if (specialCharRatio > 0.3) {
      issues.push('提示词包含过多特殊字符');
    }

    // 检查 JSON 格式（如果存在）
    const jsonBlocks = prompt.match(/\{[\s\S]*?\}/g);
    if (jsonBlocks) {
      for (const block of jsonBlocks) {
        try {
          JSON.parse(block);
        } catch {
          issues.push('提示词包含无效的 JSON 格式');
          break;
        }
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  /**
   * 创建上下文隔离的对话消息
   * @param systemPrompt 系统提示词
   * @param userMessages 用户消息
   * @param options 选项
   * @returns 消息数组
   */
  static createIsolatedMessages(
    systemPrompt: string,
    userMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: {
      addContextMarkers?: boolean;
      maxHistoryLength?: number;
    } = {}
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const { addContextMarkers = true, maxHistoryLength = 10 } = options;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      [];

    // 添加系统提示词
    messages.push({
      role: 'system',
      content:
        systemPrompt + (addContextMarkers ? '\n\n=== START OF CONVERSATION ===' : ''),
    });

    // 限制历史长度
    const recentMessages = userMessages.slice(-maxHistoryLength);

    // 添加用户和助手消息
    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        // 对用户消息进行额外净化
        const sanitized = this.sanitizeUserInput(msg.content);
        messages.push({
          role: 'user',
          content: addContextMarkers ? `USER: ${sanitized}` : sanitized,
        });
      } else {
        messages.push({
          role: 'assistant',
          content: addContextMarkers ? `ASSISTANT: ${msg.content}` : msg.content,
        });
      }
    }

    // 添加结束标记
    if (addContextMarkers) {
      messages.push({
        role: 'system',
        content: '=== END OF CONVERSATION ===\n\n请基于以上对话内容回复。',
      });
    }

    return messages;
  }

  /**
   * 生成提示词安全报告
   * @param input 输入文本
   * @returns 安全报告
   */
  static generateSecurityReport(input: string): string {
    const detection = this.detectPromptInjection(input);
    const validation = this.validatePromptStructure(input);

    let report = '=== 提示词安全报告 ===\n\n';

    report += `注入检测:\n`;
    report += `- 状态: ${detection.isInjection ? '⚠️ 检测到潜在风险' : '✅ 安全'}\n`;
    report += `- 置信度: ${(detection.confidence * 100).toFixed(1)}%\n`;
    report += `- 风险等级: ${detection.riskLevel.toUpperCase()}\n`;

    if (detection.patterns.length > 0) {
      report += `- 匹配模式:\n`;
      detection.patterns.slice(0, 3).forEach((pattern) => {
        report += `  • ${pattern}\n`;
      });
    }

    report += '\n结构验证:\n';
    report += `- 状态: ${validation.isValid ? '✅ 有效' : '⚠️ 存在问题'}\n`;
    if (validation.issues.length > 0) {
      report += `- 问题:\n`;
      validation.issues.forEach((issue) => {
        report += `  • ${issue}\n`;
      });
    }

    report += `\n统计信息:\n`;
    report += `- 长度: ${input.length} 字符\n`;
    report += `- 行数: ${input.split('\n').length} 行\n`;

    return report;
  }
}
