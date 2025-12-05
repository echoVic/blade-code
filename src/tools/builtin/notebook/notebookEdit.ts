import * as fs from 'fs/promises';
import { z } from 'zod';
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

  schema: z.object({
    notebook_path: z
      .string()
      .describe(
        'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)'
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.'
      ),
    new_source: z.string().describe('The new source for the cell'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.'
      ),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .default('replace')
      .describe(
        'The type of edit to make (replace, insert, delete). Defaults to replace.'
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
          displayContent: 'Invalid notebook format',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'Invalid notebook format',
          },
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
            displayContent: 'Cell not found',
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: `Cell ID "${cell_id}" not found`,
            },
          };
        }
      }

      switch (edit_mode) {
        case 'replace': {
          if (cellIndex === -1) {
            return {
              success: false,
              llmContent: 'Cell ID required for replace operation',
              displayContent: 'Cell ID required',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'Cell ID required for replace',
              },
            };
          }
          const cell = notebook.cells[cellIndex];
          cell.source = new_source.split('\n').map((line, i, arr) =>
            i < arr.length - 1 ? line + '\n' : line
          );
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
              displayContent: 'cell_type required',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'cell_type required for insert',
              },
            };
          }
          const newCell = {
            cell_type,
            source: new_source.split('\n').map((line, i, arr) =>
              i < arr.length - 1 ? line + '\n' : line
            ),
            metadata: {},
            ...(cell_type === 'code'
              ? { execution_count: null, outputs: [] }
              : {}),
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
              displayContent: 'Cell ID required',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'Cell ID required for delete',
              },
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
        displayContent: `Cell ${actionMsg} in notebook`,
        metadata: {
          notebook_path,
          edit_mode,
          cell_id,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        llmContent: `Failed to edit notebook: ${message}`,
        displayContent: 'Notebook edit failed',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
        },
      };
    }
  },
});
