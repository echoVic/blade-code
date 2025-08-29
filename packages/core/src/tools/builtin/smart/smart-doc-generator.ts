import { promises as fs } from 'fs';
import { dirname, extname, resolve } from 'path';
import type { ToolDefinition } from '../../types.js';

/**
 * 智能文档生成工具
 * 分析代码文件并使用LLM生成相应的文档
 */
export const smartDocGenerator: ToolDefinition = {
  name: 'smart_doc_generator',
  description: '智能分析代码文件，使用LLM生成API文档、README或技术说明',
  category: 'smart',
  version: '1.0.0',
  author: 'Agent CLI',
  tags: ['smart', 'documentation', 'api', 'readme', 'llm'],

  parameters: {
    sourcePath: {
      type: 'string',
      required: true,
      description: '要分析的源代码文件或目录路径',
    },
    outputPath: {
      type: 'string',
      required: false,
      description: '输出文档路径（默认为源文件同级目录下的README.md）',
    },
    docType: {
      type: 'string',
      required: false,
      description: '文档类型',
      enum: ['api', 'readme', 'guide', 'technical', 'auto'],
      default: 'auto',
    },
    language: {
      type: 'string',
      required: false,
      description: '编程语言（自动检测或手动指定）',
      default: 'auto',
    },
    includeExamples: {
      type: 'boolean',
      required: false,
      description: '是否包含使用示例',
      default: true,
    },
    maxFileSize: {
      type: 'number',
      required: false,
      description: '单个文件最大大小（字节）',
      default: 200 * 1024, // 200KB
    },
    overwrite: {
      type: 'boolean',
      required: false,
      description: '是否覆盖已存在的文档文件',
      default: false,
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
      sourcePath,
      outputPath,
      docType = 'auto',
      language = 'auto',
      includeExamples = true,
      maxFileSize = 200 * 1024,
      overwrite = false,
      llmAnalysis = '',
    } = parameters;

    try {
      // 1. 分析源路径
      const resolvedSourcePath = resolve(sourcePath);
      const sourceStats = await fs.stat(resolvedSourcePath);

      let codeFiles: Array<{ path: string; content: string; language: string }> = [];

      if (sourceStats.isFile()) {
        // 单个文件
        if (sourceStats.size > maxFileSize) {
          throw new Error(`文件太大 (${sourceStats.size} 字节)，超过限制 (${maxFileSize} 字节)`);
        }

        const content = await fs.readFile(resolvedSourcePath, 'utf8');
        const detectedLanguage =
          language === 'auto' ? detectLanguage(resolvedSourcePath) : language;

        codeFiles.push({
          path: resolvedSourcePath,
          content,
          language: detectedLanguage,
        });
      } else if (sourceStats.isDirectory()) {
        // 目录 - 扫描代码文件
        codeFiles = await scanCodeFiles(resolvedSourcePath, maxFileSize);
      } else {
        throw new Error('源路径必须是文件或目录');
      }

      if (codeFiles.length === 0) {
        throw new Error('未找到可分析的代码文件');
      }

      // 2. 分析代码结构
      const codeAnalysis = analyzeCodeStructure(codeFiles);

      // 3. 确定文档类型和输出路径
      const finalDocType = docType === 'auto' ? detectDocType(codeAnalysis) : docType;
      const finalOutputPath = outputPath || generateOutputPath(resolvedSourcePath, finalDocType);

      // 4. 检查输出文件是否存在
      if (!overwrite) {
        try {
          await fs.access(finalOutputPath);
          throw new Error(`输出文件已存在: ${finalOutputPath}，使用 overwrite: true 强制覆盖`);
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      // 5. 构造LLM分析提示
      const analysisPrompt = buildDocumentationPrompt(codeAnalysis, finalDocType, includeExamples);

      // 6. 如果没有LLM分析结果，返回需要分析的信号
      if (!llmAnalysis) {
        return {
          success: false,
          error: 'need_llm_analysis',
          data: {
            needsLLMAnalysis: true,
            analysisPrompt,
            sourceInfo: {
              sourcePath: resolvedSourcePath,
              outputPath: finalOutputPath,
              docType: finalDocType,
              fileCount: codeFiles.length,
              primaryLanguage: codeAnalysis.primaryLanguage,
            },
          },
        };
      }

      // 7. 处理LLM生成的文档内容
      const documentContent = processLLMDocumentation(llmAnalysis, finalDocType);

      // 8. 创建输出目录并写入文档
      await fs.mkdir(dirname(finalOutputPath), { recursive: true });
      await fs.writeFile(finalOutputPath, documentContent, 'utf8');

      // 9. 获取生成的文件信息
      const outputStats = await fs.stat(finalOutputPath);

      const result = {
        sourceInfo: {
          path: resolvedSourcePath,
          type: sourceStats.isFile() ? 'file' : 'directory',
          fileCount: codeFiles.length,
          primaryLanguage: codeAnalysis.primaryLanguage,
        },
        documentInfo: {
          path: finalOutputPath,
          type: finalDocType,
          size: outputStats.size,
          createdAt: outputStats.birthtime,
          includesExamples: includeExamples,
        },
        analysis: codeAnalysis,
        smartGenerated: true,
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: `Smart doc generation failed: ${(error as Error).message}`,
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
    '.go': 'go',
    '.rs': 'rust',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
  };

  return languageMap[ext] || 'unknown';
}

/**
 * 扫描目录中的代码文件
 */
async function scanCodeFiles(dirPath: string, maxFileSize: number) {
  const codeFiles: Array<{ path: string; content: string; language: string }> = [];
  const codeExtensions = [
    '.js',
    '.mjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.php',
    '.rb',
  ];

  async function scanDirectory(currentPath: string, depth = 0): Promise<void> {
    if (depth > 3) return; // 限制递归深度

    const items = await fs.readdir(currentPath);

    for (const item of items) {
      if (item.startsWith('.')) continue; // 跳过隐藏文件

      const itemPath = resolve(currentPath, item);
      const itemStats = await fs.stat(itemPath);

      if (itemStats.isDirectory()) {
        // 跳过常见的非源码目录
        if (['node_modules', 'dist', 'build', '.git', '__pycache__'].includes(item)) {
          continue;
        }
        await scanDirectory(itemPath, depth + 1);
      } else if (itemStats.isFile()) {
        const ext = extname(item).toLowerCase();
        if (codeExtensions.includes(ext) && itemStats.size <= maxFileSize) {
          try {
            const content = await fs.readFile(itemPath, 'utf8');
            const language = detectLanguage(itemPath);
            codeFiles.push({ path: itemPath, content, language });

            // 限制文件数量
            if (codeFiles.length >= 20) break;
          } catch (error) {
            // 忽略读取失败的文件
          }
        }
      }
    }
  }

  await scanDirectory(dirPath);
  return codeFiles;
}

/**
 * 分析代码结构
 */
function analyzeCodeStructure(
  codeFiles: Array<{ path: string; content: string; language: string }>
) {
  const languages = new Map<string, number>();
  const functions: string[] = [];
  const classes: string[] = [];
  const exports: string[] = [];
  const imports: string[] = [];

  let totalLines = 0;
  let totalSize = 0;

  for (const file of codeFiles) {
    const { content, language } = file;
    totalLines += content.split('\n').length;
    totalSize += content.length;

    // 统计语言使用
    languages.set(language, (languages.get(language) || 0) + 1);

    // 提取函数、类等结构信息
    extractCodeStructures(content, language, { functions, classes, exports, imports });
  }

  // 确定主要编程语言
  const primaryLanguage =
    Array.from(languages.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

  return {
    fileCount: codeFiles.length,
    primaryLanguage,
    languages: Object.fromEntries(languages),
    totalLines,
    totalSize,
    structures: {
      functions: Array.from(new Set(functions)).slice(0, 20),
      classes: Array.from(new Set(classes)).slice(0, 10),
      exports: Array.from(new Set(exports)).slice(0, 15),
      imports: Array.from(new Set(imports)).slice(0, 15),
    },
  };
}

/**
 * 提取代码结构信息
 */
function extractCodeStructures(
  content: string,
  language: string,
  structures: { functions: string[]; classes: string[]; exports: string[]; imports: string[] }
) {
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (language === 'javascript' || language === 'typescript') {
      // 函数
      if (trimmed.match(/^(export\s+)?(async\s+)?function\s+(\w+)/)) {
        const match = trimmed.match(/function\s+(\w+)/);
        if (match) structures.functions.push(match[1]);
      }

      // 箭头函数
      if (trimmed.match(/^(export\s+)?const\s+(\w+)\s*=\s*.*=>/)) {
        const match = trimmed.match(/const\s+(\w+)/);
        if (match) structures.functions.push(match[1]);
      }

      // 类
      if (trimmed.match(/^(export\s+)?class\s+(\w+)/)) {
        const match = trimmed.match(/class\s+(\w+)/);
        if (match) structures.classes.push(match[1]);
      }

      // 导出
      if (trimmed.startsWith('export')) {
        structures.exports.push(trimmed);
      }

      // 导入
      if (trimmed.startsWith('import')) {
        structures.imports.push(trimmed);
      }
    }

    // 可以添加其他语言的模式匹配
  }
}

/**
 * 检测文档类型
 */
function detectDocType(analysis: any): string {
  const { structures, primaryLanguage } = analysis;

  // 如果有很多导出的函数/类，可能是库或API
  if (structures.exports.length > 5 || structures.functions.length > 10) {
    return 'api';
  }

  // 如果是web相关，可能需要用户指南
  if (primaryLanguage === 'javascript' || primaryLanguage === 'typescript') {
    return 'guide';
  }

  // 默认生成README
  return 'readme';
}

/**
 * 生成输出路径
 */
function generateOutputPath(sourcePath: string, docType: string): string {
  const sourceDir = dirname(sourcePath);

  const fileNames: Record<string, string> = {
    api: 'API.md',
    readme: 'README.md',
    guide: 'GUIDE.md',
    technical: 'TECHNICAL.md',
  };

  const fileName = fileNames[docType] || 'README.md';
  return resolve(sourceDir, fileName);
}

/**
 * 构造文档生成提示
 */
function buildDocumentationPrompt(
  analysis: any,
  docType: string,
  includeExamples: boolean
): string {
  const { primaryLanguage, structures, fileCount, totalLines } = analysis;

  const exampleNote = includeExamples ? '并包含实际的使用示例' : '';

  return `请为以下${primaryLanguage}项目生成${getDocTypeDescription(docType)}文档${exampleNote}。

项目分析信息:
- 主要语言: ${primaryLanguage}
- 文件数量: ${fileCount}
- 总代码行数: ${totalLines}
- 主要函数: ${structures.functions.slice(0, 10).join(', ')}
- 主要类: ${structures.classes.slice(0, 5).join(', ')}
- 关键导出: ${structures.exports.slice(0, 5).join('; ')}

请生成一个专业、详细且结构化的${getDocTypeDescription(docType)}文档，包含以下部分：

1. **项目概述** - 简明扼要地描述项目功能和用途
2. **安装说明** - 如何安装和配置项目
3. **快速开始** - 基本使用方法和入门示例
4. **API文档** - 主要函数、类和方法的详细说明（如果适用）
5. **使用示例** - 实际的代码示例展示如何使用${includeExamples ? '（必须包含）' : ''}
6. **配置选项** - 重要的配置参数和选项
7. **故障排除** - 常见问题和解决方案
8. **贡献指南** - 如何参与项目开发（如果适用）

要求：
- 使用Markdown格式
- 代码示例要完整且可运行
- 语言简洁清晰，适合技术文档
- 结构层次分明，便于阅读
- 根据实际的代码结构来生成内容，不要虚构不存在的功能

请直接返回完整的Markdown文档内容。`;
}

/**
 * 获取文档类型描述
 */
function getDocTypeDescription(docType: string): string {
  const descriptions: Record<string, string> = {
    api: 'API参考',
    readme: 'README',
    guide: '用户指南',
    technical: '技术文档',
  };

  return descriptions[docType] || 'README';
}

/**
 * 处理LLM生成的文档内容
 */
function processLLMDocumentation(llmAnalysis: string, docType: string): string {
  let content = llmAnalysis.trim();

  // 移除可能的markdown代码块包装
  content = content.replace(/^```markdown\n?|\n?```$/g, '');
  content = content.replace(/^```\n?|\n?```$/g, '');

  // 确保有标题
  if (!content.startsWith('#')) {
    const title = getDocTypeDescription(docType);
    content = `# ${title}\n\n${content}`;
  }

  // 添加生成信息
  const timestamp = new Date().toISOString().split('T')[0];
  content += `\n\n---\n\n*此文档由 Agent CLI 智能生成，生成时间：${timestamp}*\n`;

  return content;
}
