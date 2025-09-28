import { promises as fs } from 'fs';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type { 
  ToolInvocation, 
  ToolResult, 
  JSONSchema7,
  ConfirmationDetails 
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * 文件编辑参数接口
 */
interface EditParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * 文件编辑工具调用实现
 */
class EditToolInvocation extends BaseToolInvocation<EditParams> {
  constructor(params: EditParams) {
    super('edit', params);
  }

  getDescription(): string {
    const { file_path, old_string, new_string, replace_all } = this.params;
    const action = replace_all ? '替换所有' : '替换首个';
    const preview = old_string.length > 50 ? `${old_string.substring(0, 50)}...` : old_string;
    return `${action}匹配项: "${preview}" → "${new_string}" (${file_path})`;
  }

  getAffectedPaths(): string[] {
    return [this.params.file_path];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { file_path, old_string, new_string, replace_all } = this.params;
    
    try {
      // 读取文件内容预览替换操作
      const content = await fs.readFile(file_path, 'utf8');
      const matches = this.findMatches(content, old_string);
      
      if (matches.length === 0) {
        return {
          type: 'edit',
          title: '未找到匹配内容',
          message: `在文件 ${file_path} 中未找到要替换的内容`,
          risks: ['操作将不会进行任何更改'],
          affectedFiles: [file_path]
        };
      }

      const replaceCount = replace_all ? matches.length : 1;
      return {
        type: 'edit',
        title: '确认文件编辑',
        message: `将在 ${file_path} 中${replace_all ? '替换所有' : '替换首个'}匹配项 (共找到${matches.length}处)`,
        risks: [
          `将替换 ${replaceCount} 处匹配项`,
          '此操作将直接修改文件',
          '建议先备份重要文件'
        ],
        affectedFiles: [file_path]
      };
    } catch (error) {
      return {
        type: 'edit',
        title: '文件访问错误',
        message: `无法读取文件 ${file_path}: ${(error as Error).message}`,
        risks: ['文件可能不存在或无权访问'],
        affectedFiles: [file_path]
      };
    }
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const { file_path, old_string, new_string, replace_all = false } = this.params;

      updateOutput?.('开始读取文件...');
      
      // 读取文件内容
      let content: string;
      try {
        content = await fs.readFile(file_path, 'utf8');
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return this.createErrorResult(`文件不存在: ${file_path}`);
        }
        throw error;
      }

      this.checkAbortSignal(signal);

      // 验证字符串不能相同
      if (old_string === new_string) {
        return this.createErrorResult('新字符串与旧字符串相同，无需进行替换');
      }

      // 查找匹配项
      const matches = this.findMatches(content, old_string);
      
      if (matches.length === 0) {
        return this.createErrorResult(`在文件中未找到要替换的字符串: "${old_string}"`);
      }

      updateOutput?.(`找到 ${matches.length} 个匹配项，开始替换...`);

      // 执行替换
      let newContent: string;
      let replacedCount: number;
      
      if (replace_all) {
        // 替换所有匹配项
        newContent = content.split(old_string).join(new_string);
        replacedCount = matches.length;
      } else {
        // 只替换第一个匹配项
        const firstMatchIndex = content.indexOf(old_string);
        newContent = content.substring(0, firstMatchIndex) + 
                    new_string + 
                    content.substring(firstMatchIndex + old_string.length);
        replacedCount = 1;
      }

      this.checkAbortSignal(signal);

      // 写入文件
      await fs.writeFile(file_path, newContent, 'utf8');

      // 验证写入成功
      const stats = await fs.stat(file_path);
      
      const metadata: Record<string, any> = {
        file_path,
        matches_found: matches.length,
        replacements_made: replacedCount,
        replace_all,
        old_string_length: old_string.length,
        new_string_length: new_string.length,
        original_size: content.length,
        new_size: newContent.length,
        size_diff: newContent.length - content.length,
        last_modified: stats.mtime.toISOString()
      };

      const displayMessage = this.formatDisplayMessage(metadata);
      
      return this.createSuccessResult(
        { 
          file_path, 
          replacements: replacedCount,
          total_matches: matches.length
        },
        displayMessage,
        metadata
      );

    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private findMatches(content: string, searchString: string): number[] {
    const matches: number[] = [];
    let index = content.indexOf(searchString);
    
    while (index !== -1) {
      matches.push(index);
      index = content.indexOf(searchString, index + 1);
    }
    
    return matches;
  }

  private formatDisplayMessage(metadata: Record<string, any>): string {
    const { 
      file_path, 
      matches_found, 
      replacements_made, 
      replace_all, 
      size_diff 
    } = metadata;

    let message = `成功编辑文件: ${file_path}`;
    message += `\n替换了 ${replacements_made} 个匹配项`;
    
    if (!replace_all && matches_found > 1) {
      message += ` (共找到 ${matches_found} 个匹配项)`;
    }
    
    if (size_diff !== 0) {
      const sizeChange = size_diff > 0 ? `增加${size_diff}` : `减少${Math.abs(size_diff)}`;
      message += `\n文件大小${sizeChange}个字符`;
    }
    
    return message;
  }
}

/**
 * 文件编辑工具
 * 提供精确的字符串替换功能
 */
export class EditTool extends DeclarativeTool<EditParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要编辑的文件路径（绝对路径）'
        },
        old_string: {
          type: 'string',
          description: '要替换的字符串'
        },
        new_string: {
          type: 'string',
          description: '新的字符串内容'
        },
        replace_all: {
          type: 'boolean',
          default: false,
          description: '是否替换所有匹配项（默认只替换第一个）'
        }
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false
    };

    super(
      'edit',
      '文件编辑',
      '在文件中进行精确的字符串替换，支持替换单个或所有匹配项',
      ToolKind.Edit,
      schema,
      true, // 编辑操作需要确认
      '1.0.0',
      '文件操作',
      ['file', 'edit', 'replace', 'modify']
    );
  }

  build(params: EditParams): ToolInvocation<EditParams> {
    // 验证参数
    const filePath = this.validateString(params.file_path, 'file_path', { 
      required: true,
      minLength: 1
    });

    const oldString = this.validateString(params.old_string, 'old_string', { 
      required: true,
      minLength: 1
    });

    const newString = this.validateString(params.new_string, 'new_string', { 
      required: true
    });

    const replaceAll = this.validateBoolean(params.replace_all ?? false, 'replace_all');

    const validatedParams: EditParams = {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll
    };

    return new EditToolInvocation(validatedParams);
  }
}