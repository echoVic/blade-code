import type { ToolDefinition } from '../types.js';

/**
 * 文本长度统计工具
 */
const textLengthTool: ToolDefinition = {
  name: 'text_length',
  description: '计算文本长度（字符数、单词数、行数）',
  version: '1.0.0',
  category: 'text',
  tags: ['text', 'analysis', 'length'],
  parameters: {
    text: {
      type: 'string',
      description: '要分析的文本内容',
      required: true,
    },
    countType: {
      type: 'string',
      description: '计数类型',
      enum: ['characters', 'words', 'lines', 'all'],
      default: 'all',
    },
  },
  required: ['text'],
  async execute(params) {
    const { text, countType } = params;

    const characters = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text.split('\n').length;

    let result;

    switch (countType) {
      case 'characters':
        result = { characters };
        break;
      case 'words':
        result = { words };
        break;
      case 'lines':
        result = { lines };
        break;
      default:
        result = { characters, words, lines };
    }

    return {
      success: true,
      data: result,
    };
  },
};

/**
 * 文本格式化工具
 */
const textFormatTool: ToolDefinition = {
  name: 'text_format',
  description: '格式化文本（大小写转换、去除空白等）',
  version: '1.0.0',
  category: 'text',
  tags: ['text', 'format', 'transform'],
  parameters: {
    text: {
      type: 'string',
      description: '要格式化的文本',
      required: true,
    },
    operation: {
      type: 'string',
      description: '格式化操作',
      enum: ['uppercase', 'lowercase', 'capitalize', 'trim', 'compact'],
      required: true,
    },
  },
  required: ['text', 'operation'],
  async execute(params) {
    const { text, operation } = params;
    let result: string;

    switch (operation) {
      case 'uppercase':
        result = text.toUpperCase();
        break;
      case 'lowercase':
        result = text.toLowerCase();
        break;
      case 'capitalize':
        result = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
        break;
      case 'trim':
        result = text.trim();
        break;
      case 'compact':
        result = text.replace(/\s+/g, ' ').trim();
        break;
      default:
        return {
          success: false,
          error: `不支持的操作: ${operation}`,
        };
    }

    return {
      success: true,
      data: { original: text, formatted: result },
    };
  },
};

/**
 * 文本搜索工具
 */
const textSearchTool: ToolDefinition = {
  name: 'text_search',
  description: '在文本中搜索指定内容',
  version: '1.0.0',
  category: 'text',
  tags: ['text', 'search', 'find'],
  parameters: {
    text: {
      type: 'string',
      description: '要搜索的文本',
      required: true,
    },
    pattern: {
      type: 'string',
      description: '搜索模式（支持正则表达式）',
      required: true,
    },
    caseSensitive: {
      type: 'boolean',
      description: '是否区分大小写',
      default: false,
    },
    useRegex: {
      type: 'boolean',
      description: '是否使用正则表达式',
      default: false,
    },
  },
  required: ['text', 'pattern'],
  async execute(params) {
    const { text, pattern, caseSensitive, useRegex } = params;

    try {
      let matches: RegExpMatchArray[] = [];

      if (useRegex) {
        const flags = caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(pattern, flags);
        const globalMatches = text.matchAll(regex);
        matches = Array.from(globalMatches);
      } else {
        const searchText = caseSensitive ? text : text.toLowerCase();
        const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

        let index = 0;
        while (index < searchText.length) {
          const found = searchText.indexOf(searchPattern, index);
          if (found === -1) break;

          matches.push({
            0: text.substring(found, found + pattern.length),
            index: found,
            input: text,
            groups: undefined,
          } as RegExpMatchArray);

          index = found + 1;
        }
      }

      return {
        success: true,
        data: {
          pattern,
          matches: matches.map(match => ({
            text: match[0],
            index: match.index,
            length: match[0].length,
          })),
          count: matches.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `搜索失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * 文本替换工具
 */
const textReplaceTool: ToolDefinition = {
  name: 'text_replace',
  description: '替换文本中的指定内容',
  version: '1.0.0',
  category: 'text',
  tags: ['text', 'replace', 'transform'],
  parameters: {
    text: {
      type: 'string',
      description: '原始文本',
      required: true,
    },
    search: {
      type: 'string',
      description: '要搜索的内容',
      required: true,
    },
    replace: {
      type: 'string',
      description: '替换为的内容',
      required: true,
    },
    caseSensitive: {
      type: 'boolean',
      description: '是否区分大小写',
      default: false,
    },
    useRegex: {
      type: 'boolean',
      description: '是否使用正则表达式',
      default: false,
    },
    replaceAll: {
      type: 'boolean',
      description: '是否替换所有匹配项',
      default: true,
    },
  },
  required: ['text', 'search', 'replace'],
  async execute(params) {
    const { text, search, replace, caseSensitive, useRegex, replaceAll } = params;

    try {
      let result: string;

      if (useRegex) {
        const flags = caseSensitive ? (replaceAll ? 'g' : '') : replaceAll ? 'gi' : 'i';
        const regex = new RegExp(search, flags);
        result = text.replace(regex, replace);
      } else {
        if (replaceAll) {
          if (caseSensitive) {
            result = text.split(search).join(replace);
          } else {
            const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            result = text.replace(regex, replace);
          }
        } else {
          if (caseSensitive) {
            const index = text.indexOf(search);
            if (index !== -1) {
              result = text.substring(0, index) + replace + text.substring(index + search.length);
            } else {
              result = text;
            }
          } else {
            const lowerText = text.toLowerCase();
            const lowerSearch = search.toLowerCase();
            const index = lowerText.indexOf(lowerSearch);
            if (index !== -1) {
              result = text.substring(0, index) + replace + text.substring(index + search.length);
            } else {
              result = text;
            }
          }
        }
      }

      const changes = text !== result;

      return {
        success: true,
        data: {
          original: text,
          result,
          changed: changes,
          length: {
            before: text.length,
            after: result.length,
            difference: result.length - text.length,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `替换失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * 导出所有文本处理工具
 */
export const textProcessingTools: ToolDefinition[] = [
  textLengthTool,
  textFormatTool,
  textSearchTool,
  textReplaceTool,
];
 