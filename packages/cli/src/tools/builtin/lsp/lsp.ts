import type { LspSessionManager } from '../../../lsp/LspSessionManager.js';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { formatLspResult } from './formatLspResult.js';

const OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
  'diagnostics',
] as const;

export function createLspTool(manager: LspSessionManager) {
  return createTool({
    name: 'LSP',
    displayName: 'Code Intelligence',
    kind: ToolKind.ReadOnly,
    strict: true,
    isConcurrencySafe: true,
    parallelism: 'shared',
    schema: Type.Object({
      operation: StringEnum(OPERATIONS, {
        description: 'Code intelligence operation',
      }),
      filePath: ToolSchemas.filePath({
        description: 'Absolute path to a file inside the Session workspace',
      }),
      line: Default(
        Type.Integer({
          minimum: 1,
          description: '1-based line number for position operations',
        }),
        1
      ),
      character: Default(
        Type.Integer({
          minimum: 1,
          description: '1-based character offset for position operations',
        }),
        1
      ),
      query: Default(
        Type.String({
          description: 'Search text for workspaceSymbol',
        }),
        ''
      ),
    }),
    description: {
      short: 'Queries configured language servers for code intelligence',
      long:
        'Find definitions, references, implementations, symbols, call hierarchy, ' +
        'hover information, and current diagnostics without text search.',
      usageNotes: [
        'Use 1-based line and character positions exactly as shown by Read.',
        'The target must be an existing file inside the current Session workspace.',
        'Use workspaceSymbol with query to search semantic symbols across the project.',
        'LSP is unavailable for ACP-owned remote files.',
      ],
    },
    async execute(params, context) {
      try {
        const response = await manager.query(params, context.signal);
        const formatted = formatLspResult(
          response.operation,
          response.result,
          manager.workspacePath
        );
        return {
          success: true,
          llmContent: formatted,
          metadata: {
            operation: response.operation,
            file_path: response.filePath,
            server: response.serverName,
            summary: `LSP ${response.operation} in ${response.filePath}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          llmContent: `LSP request failed: ${message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message,
          },
          metadata: {
            operation: params.operation,
            file_path: params.filePath,
            summary: `LSP ${params.operation} failed`,
          },
        };
      }
    },
    extractSignatureContent: (params) => params.filePath,
    abstractPermissionRule: (params) => params.filePath,
    version: '1.0.0',
    category: 'Code Intelligence',
    tags: ['lsp', 'code-intelligence', 'diagnostics'],
  });
}
