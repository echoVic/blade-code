import { promises as fs } from 'fs';
import { extname, resolve } from 'path';
import type { ToolDefinition } from '../../types.js';

/**
 * 智能代码审查工具
 * 使用LLM分析代码质量、性能、安全性等方面
 */
export const smartCodeReview: ToolDefinition = {
  name: 'smart_code_review',
  description: '智能分析代码质量，使用LLM提供详细的审查报告和改进建议',
  category: 'smart',
  version: '1.0.0',
  author: 'Agent CLI',
  tags: ['smart', 'code', 'review', 'llm', 'analysis'],

  parameters: {
    path: {
      type: 'string',
      required: true,
      description: '要审查的代码文件路径',
    },
    language: {
      type: 'string',
      required: false,
      description: '编程语言（自动检测或手动指定）',
      default: 'auto',
    },
    reviewType: {
      type: 'string',
      required: false,
      description: '审查类型',
      enum: ['full', 'security', 'performance', 'style', 'maintainability'],
      default: 'full',
    },
    maxFileSize: {
      type: 'number',
      required: false,
      description: '最大文件大小（字节）',
      default: 100 * 1024, // 100KB
    },
    llmAnalysis: {
      type: 'string',
      required: false,
      description: 'LLM分析结果（由Agent自动填充）',
      default: '',
    },
  },

  async execute(parameters) {
    const {
      path,
      language = 'auto',
      reviewType = 'full',
      maxFileSize = 100 * 1024,
      llmAnalysis = '',
    } = parameters;

    try {
      // 1. 读取代码文件
      const resolvedPath = resolve(path);

      // 检查文件是否存在
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        throw new Error('指定路径不是文件');
      }

      // 检查文件大小
      if (stats.size > maxFileSize) {
        throw new Error(`文件太大 (${stats.size} 字节)，超过限制 (${maxFileSize} 字节)`);
      }

      // 读取文件内容
      const content = await fs.readFile(resolvedPath, 'utf8');

      // 2. 自动检测编程语言
      const detectedLanguage = language === 'auto' ? detectLanguage(resolvedPath) : language;

      // 3. 分析代码基本信息
      const codeStats = analyzeCodeStats(content);

      // 4. 构造LLM分析提示
      const analysisPrompt = buildAnalysisPrompt(content, detectedLanguage, reviewType, codeStats);

      // 5. 如果没有LLM分析结果，返回需要分析的信号
      if (!llmAnalysis) {
        return {
          success: false,
          error: 'need_llm_analysis',
          data: {
            needsLLMAnalysis: true,
            analysisPrompt,
            fileInfo: {
              path: resolvedPath,
              language: detectedLanguage,
              size: stats.size,
              lines: codeStats.totalLines,
              reviewType,
            },
          },
        };
      }

      // 6. 解析LLM分析结果
      const reviewReport = parseLLMAnalysis(llmAnalysis);

      // 7. 生成最终报告
      const finalReport = {
        fileInfo: {
          path: resolvedPath,
          language: detectedLanguage,
          size: stats.size,
          modified: stats.mtime,
          reviewType,
          reviewedAt: new Date().toISOString(),
        },
        codeStats,
        analysis: reviewReport,
        smartGenerated: true,
      };

      return {
        success: true,
        data: finalReport,
      };
    } catch (error) {
      return {
        success: false,
        error: `Smart code review failed: ${(error as Error).message}`,
        data: null,
      };
    }
  },
};

/**
 * 检测编程语言
 */
function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.dart': 'dart',
    '.sh': 'bash',
    '.sql': 'sql',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.xml': 'xml',
  };

  return languageMap[ext] || 'unknown';
}

/**
 * 分析代码统计信息
 */
function analyzeCodeStats(content: string) {
  const lines = content.split('\n');
  const totalLines = lines.length;

  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankLines++;
    } else if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('<!--')
    ) {
      commentLines++;
    } else {
      codeLines++;
    }
  }

  return {
    totalLines,
    codeLines,
    commentLines,
    blankLines,
    commentRatio: commentLines / totalLines,
    avgLineLength: content.length / totalLines,
  };
}

/**
 * 构造LLM分析提示
 */
function buildAnalysisPrompt(
  content: string,
  language: string,
  reviewType: string,
  stats: any
): string {
  const reviewFocus = getReviewFocus(reviewType);

  // 如果文件太长，截取前面部分
  const truncatedContent =
    content.length > 3000
      ? content.substring(0, 3000) + '\n... (代码已截取，共' + stats.totalLines + '行)'
      : content;

  return `请对以下${language}代码进行专业的代码审查，重点关注${reviewFocus}。

代码统计信息:
- 总行数: ${stats.totalLines}
- 代码行数: ${stats.codeLines}
- 注释行数: ${stats.commentLines}
- 注释率: ${(stats.commentRatio * 100).toFixed(1)}%

代码内容:
\`\`\`${language}
${truncatedContent}
\`\`\`

请从以下方面进行分析并提供JSON格式的报告：

{
  "overallScore": 评分(1-10),
  "summary": "总体评价和主要问题概述",
  "issues": [
    {
      "type": "问题类型(security/performance/style/maintainability/bug)",
      "severity": "严重级别(high/medium/low)",
      "description": "问题描述",
      "suggestion": "改进建议",
      "lineRange": "相关行数范围(如果适用)"
    }
  ],
  "strengths": ["代码优点列表"],
  "recommendations": ["具体改进建议列表"],
  "securityConcerns": ["安全问题列表"],
  "performanceNotes": ["性能相关建议"],
  "maintainabilityScore": 可维护性评分(1-10)
}

请确保分析详细、准确，并提供可操作的改进建议。`;
}

/**
 * 获取审查重点
 */
function getReviewFocus(reviewType: string): string {
  const focusMap: Record<string, string> = {
    full: '代码质量、性能、安全性和可维护性',
    security: '安全漏洞和潜在风险',
    performance: '性能优化和执行效率',
    style: '代码风格和规范性',
    maintainability: '可维护性和代码结构',
  };

  return focusMap[reviewType] || '代码质量';
}

/**
 * 解析LLM分析结果
 */
function parseLLMAnalysis(llmAnalysis: string) {
  try {
    // 清理可能的markdown格式
    const cleanAnalysis = llmAnalysis.replace(/```json\n?|\n?```/g, '').trim();

    const parsed = JSON.parse(cleanAnalysis);

    // 验证必要字段
    return {
      overallScore: parsed.overallScore || 0,
      summary: parsed.summary || '分析结果解析失败',
      issues: parsed.issues || [],
      strengths: parsed.strengths || [],
      recommendations: parsed.recommendations || [],
      securityConcerns: parsed.securityConcerns || [],
      performanceNotes: parsed.performanceNotes || [],
      maintainabilityScore: parsed.maintainabilityScore || 0,
    };
  } catch (error) {
    // 如果JSON解析失败，返回原始文本分析
    return {
      overallScore: 0,
      summary: '分析结果格式错误，但包含以下内容',
      rawAnalysis: llmAnalysis,
      issues: [],
      strengths: [],
      recommendations: [],
      securityConcerns: [],
      performanceNotes: [],
      maintainabilityScore: 0,
    };
  }
}
