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
 * 编辑操作接口
 */
interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * 批量编辑参数接口
 */
interface MultiEditParams {
  file_path: string;
  edits: EditOperation[];
}

/**
 * 批量编辑工具调用实现
 */
class MultiEditToolInvocation extends BaseToolInvocation<MultiEditParams> {
  constructor(params: MultiEditParams) {
    super('multi_edit', params);
  }

  getDescription(): string {
    const { file_path, edits } = this.params;
    return `在 ${file_path} 中执行 ${edits.length} 个编辑操作`;
  }

  getAffectedPaths(): string[] {
    return [this.params.file_path];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { file_path, edits } = this.params;
    
    try {
      // 读取文件内容预览编辑操作
      const content = await fs.readFile(file_path, 'utf8');
      const previewInfo = this.analyzeEdits(content, edits);
      
      if (previewInfo.totalMatches === 0) {
        return {
          type: 'edit',
          title: '未找到匹配内容',
          message: `在文件 ${file_path} 中未找到任何要替换的内容`,
          risks: ['操作将不会进行任何更改'],
          affectedFiles: [file_path]
        };
      }

      return {
        type: 'edit',
        title: '确认批量编辑',
        message: `将在 ${file_path} 中执行 ${edits.length} 个编辑操作`,
        risks: [
          `总共将替换 ${previewInfo.totalReplacements} 处内容`,
          `涉及 ${previewInfo.successfulEdits} 个有效编辑操作`,
          '此操作将按顺序执行所有编辑，后续编辑基于前面编辑的结果',
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

      const { file_path, edits } = this.params;

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

      // 验证编辑操作
      const validationResult = this.validateEdits(edits);
      if (!validationResult.isValid) {
        return this.createErrorResult(validationResult.error!);
      }

      updateOutput?.(`开始执行 ${edits.length} 个编辑操作...`);

      // 按顺序执行编辑操作
      let currentContent = content;
      const operationResults: Array<{
        index: number;
        operation: EditOperation;
        success: boolean;
        matchesFound: number;
        replacementsMade: number;
        error?: string;
      }> = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        
        updateOutput?.(`执行编辑操作 ${i + 1}/${edits.length}...`);
        
        try {
          const result = this.applyEdit(currentContent, edit);
          currentContent = result.newContent;
          
          operationResults.push({
            index: i,
            operation: edit,
            success: true,
            matchesFound: result.matchesFound,
            replacementsMade: result.replacementsMade
          });
          
          this.checkAbortSignal(signal);
        } catch (error: any) {
          operationResults.push({
            index: i,
            operation: edit,
            success: false,
            matchesFound: 0,
            replacementsMade: 0,
            error: error.message
          });
        }
      }

      // 写入文件
      updateOutput?.('写入修改后的文件...');
      await fs.writeFile(file_path, currentContent, 'utf8');

      // 验证写入成功
      const stats = await fs.stat(file_path);
      
      const successfulOperations = operationResults.filter(r => r.success);
      const totalReplacements = successfulOperations.reduce((sum, r) => sum + r.replacementsMade, 0);
      
      const metadata: Record<string, any> = {
        file_path,
        total_operations: edits.length,
        successful_operations: successfulOperations.length,
        failed_operations: edits.length - successfulOperations.length,
        total_replacements: totalReplacements,
        original_size: content.length,
        new_size: currentContent.length,
        size_diff: currentContent.length - content.length,
        operation_results: operationResults,
        last_modified: stats.mtime.toISOString()
      };

      const displayMessage = this.formatDisplayMessage(metadata);
      
      return this.createSuccessResult(
        { 
          file_path, 
          operations_completed: successfulOperations.length,
          total_replacements: totalReplacements,
          operations_failed: edits.length - successfulOperations.length
        },
        displayMessage,
        metadata
      );

    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private analyzeEdits(content: string, edits: EditOperation[]) {
    let totalMatches = 0;
    let totalReplacements = 0;
    let successfulEdits = 0;

    for (const edit of edits) {
      const matches = this.findMatches(content, edit.old_string);
      if (matches.length > 0) {
        successfulEdits++;
        totalMatches += matches.length;
        totalReplacements += edit.replace_all ? matches.length : 1;
      }
    }

    return { totalMatches, totalReplacements, successfulEdits };
  }

  private validateEdits(edits: EditOperation[]): { isValid: boolean; error?: string } {
    if (edits.length === 0) {
      return { isValid: false, error: '编辑操作列表不能为空' };
    }

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      
      if (!edit.old_string || edit.old_string.length === 0) {
        return { isValid: false, error: `编辑操作 ${i + 1}: old_string 不能为空` };
      }
      
      if (edit.new_string === undefined || edit.new_string === null) {
        return { isValid: false, error: `编辑操作 ${i + 1}: new_string 不能为空` };
      }
      
      if (edit.old_string === edit.new_string) {
        return { isValid: false, error: `编辑操作 ${i + 1}: 新字符串与旧字符串相同` };
      }
    }

    return { isValid: true };
  }

  private applyEdit(content: string, edit: EditOperation) {
    const matches = this.findMatches(content, edit.old_string);
    
    if (matches.length === 0) {
      throw new Error(`未找到要替换的字符串: "${edit.old_string}"`);
    }

    let newContent: string;
    let replacementsMade: number;

    if (edit.replace_all) {
      newContent = content.split(edit.old_string).join(edit.new_string);
      replacementsMade = matches.length;
    } else {
      const firstMatchIndex = content.indexOf(edit.old_string);
      newContent = content.substring(0, firstMatchIndex) + 
                  edit.new_string + 
                  content.substring(firstMatchIndex + edit.old_string.length);
      replacementsMade = 1;
    }

    return {
      newContent,
      matchesFound: matches.length,
      replacementsMade
    };
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
      successful_operations,
      failed_operations,
      total_replacements, 
      size_diff 
    } = metadata;

    let message = `成功批量编辑文件: ${file_path}`;
    message += `\n完成 ${successful_operations} 个编辑操作`;
    
    if (failed_operations > 0) {
      message += ` (${failed_operations} 个操作失败)`;
    }
    
    message += `\n总共替换了 ${total_replacements} 处内容`;
    
    if (size_diff !== 0) {
      const sizeChange = size_diff > 0 ? `增加${size_diff}` : `减少${Math.abs(size_diff)}`;
      message += `\n文件大小${sizeChange}个字符`;
    }
    
    return message;
  }
}

/**
 * 批量编辑工具
 * 在单个文件中执行多个编辑操作
 */
export class MultiEditTool extends DeclarativeTool<MultiEditParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要编辑的文件路径（绝对路径）'
        },
        edits: {
          type: 'array',
          description: '编辑操作列表，按顺序执行',
          items: {
            type: 'object',
            properties: {
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
            required: ['old_string', 'new_string'],
            additionalProperties: false
          },
          minItems: 1
        }
      },
      required: ['file_path', 'edits'],
      additionalProperties: false
    };

    super(
      'multi_edit',
      '批量编辑',
      '在单个文件中按顺序执行多个字符串替换操作',
      ToolKind.Edit,
      schema,
      true, // 批量编辑操作需要确认
      '1.0.0',
      '文件操作',
      ['file', 'edit', 'batch', 'multi', 'replace']
    );
  }

  build(params: MultiEditParams): ToolInvocation<MultiEditParams> {
    // 验证参数
    const filePath = this.validateString(params.file_path, 'file_path', { 
      required: true,
      minLength: 1
    });

    const edits = this.validateArray(params.edits, 'edits', {
      required: true,
      minLength: 1,
      itemValidator: (item: any, index: number): EditOperation => {
        if (typeof item !== 'object' || item === null) {
          this.createValidationError('edits', `编辑操作 ${index + 1} 必须是对象类型`, item);
        }

        const oldString = this.validateString(item.old_string, `edits[${index}].old_string`, { 
          required: true,
          minLength: 1
        });

        const newString = this.validateString(item.new_string, `edits[${index}].new_string`, { 
          required: true
        });

        const replaceAll = this.validateBoolean(item.replace_all ?? false, `edits[${index}].replace_all`);

        return {
          old_string: oldString,
          new_string: newString,
          replace_all: replaceAll
        };
      }
    });

    const validatedParams: MultiEditParams = {
      file_path: filePath,
      edits
    };

    return new MultiEditToolInvocation(validatedParams);
  }
}