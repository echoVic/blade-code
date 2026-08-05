import * as fs from 'fs/promises';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * NotebookEdit tool
 * Edit Jupyter notebook cells
 */
export const notebookEditTool = createTool({
  name: 'NotebookEdit',
  displayName: 'Notebook Edit',
  kind: ToolKind.Write,
  isConcurrencySafe: false, // 文件写入操作

  schema: Type.Object({
    notebook_path: Type.String({
      description:
        'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
    }),
    cell_id: Type.Optional(
      Type.String({
        description:
          'The ID of the cell to edit. New cells are inserted after it, or at the beginning when omitted.',
      })
    ),
    new_source: Type.String({ description: 'The new source for the cell' }),
    cell_type: Type.Optional(
      StringEnum(['code', 'markdown'], {
        description:
          'Cell type. Required for insert; otherwise defaults to the current type.',
      })
    ),
    edit_mode: Default(
      StringEnum(['replace', 'insert', 'delete'], {
        description: 'The edit operation. Defaults to replace.',
      }),
      'replace'
    ),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Completely replaces the contents of a specific cell in a Jupyter notebook',
    long: `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const {
      notebook_path,
      cell_id,
      new_source,
      cell_type,
      edit_mode = 'replace',
    } = params;

    try {
      // Read notebook file
      const content = await fs.readFile(notebook_path, 'utf-8');
      const notebook = JSON.parse(content);

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return {
          success: false,
          llmContent: 'Invalid notebook format: no cells array found',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'Invalid notebook format',
          },
          metadata: { summary: '无效的 Notebook 格式' },
        };
      }

      // Find cell by ID or use index
      let cellIndex = -1;
      if (cell_id) {
        cellIndex = notebook.cells.findIndex(
          (cell: { id?: string }) => cell.id === cell_id
        );
        if (cellIndex === -1 && edit_mode !== 'insert') {
          return {
            success: false,
            llmContent: `Cell with ID "${cell_id}" not found`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: `Cell ID "${cell_id}" not found`,
            },
            metadata: { summary: `Cell 未找到: ${cell_id}` },
          };
        }
      }

      switch (edit_mode) {
        case 'replace': {
          if (cellIndex === -1) {
            return {
              success: false,
              llmContent: 'Cell ID required for replace operation',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'Cell ID required for replace',
              },
              metadata: { summary: '替换操作需要 Cell ID' },
            };
          }
          const cell = notebook.cells[cellIndex];
          cell.source = new_source
            .split('\n')
            .map((line, i, arr) => (i < arr.length - 1 ? line + '\n' : line));
          if (cell_type) {
            cell.cell_type = cell_type;
          }
          break;
        }

        case 'insert': {
          if (!cell_type) {
            return {
              success: false,
              llmContent: 'cell_type is required for insert operation',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'cell_type required for insert',
              },
              metadata: { summary: '插入操作需要 cell_type' },
            };
          }
          const newCell = {
            cell_type,
            source: new_source
              .split('\n')
              .map((line, i, arr) => (i < arr.length - 1 ? line + '\n' : line)),
            metadata: {},
            ...(cell_type === 'code' ? { execution_count: null, outputs: [] } : {}),
          };
          const insertIndex = cellIndex === -1 ? 0 : cellIndex + 1;
          notebook.cells.splice(insertIndex, 0, newCell);
          break;
        }

        case 'delete': {
          if (cellIndex === -1) {
            return {
              success: false,
              llmContent: 'Cell ID required for delete operation',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'Cell ID required for delete',
              },
              metadata: { summary: '删除操作需要 Cell ID' },
            };
          }
          notebook.cells.splice(cellIndex, 1);
          break;
        }
      }

      // Write back to file
      await fs.writeFile(notebook_path, JSON.stringify(notebook, null, 2));

      const actionMsg =
        edit_mode === 'replace'
          ? 'replaced'
          : edit_mode === 'insert'
            ? 'inserted'
            : 'deleted';

      return {
        success: true,
        llmContent: `Successfully ${actionMsg} cell in ${notebook_path}`,
        metadata: {
          notebook_path,
          edit_mode,
          cell_id,
          summary: `Notebook cell ${actionMsg}: ${notebook_path}`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        llmContent: `Failed to edit notebook: ${message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
        },
        metadata: { summary: '编辑 Notebook 失败' },
      };
    }
  },
});
