import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { TOOL_CALL_ERROR_CODES } from '../../../../../src/tools/execution/ToolExecutionResults.js';
import { ToolExecutor } from '../../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import { ToolErrorType, ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

function createExecutor(execute = vi.fn()) {
  const registry = new ToolRegistry();
  registry.register(
    createTool({
      name: 'Lookup',
      displayName: 'Lookup',
      kind: ToolKind.ReadOnly,
      isConcurrencySafe: true,
      schema: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      description: { short: 'Look up a value' },
      async execute(params) {
        execute(params);
        return { success: true, llmContent: params.query };
      },
    }) as never
  );
  return new ToolExecutor(registry, { permissionMode: PermissionMode.YOLO });
}

describe('ToolExecutor malformed call error codes', () => {
  it('marks an unregistered tool name as unknown_tool', async () => {
    const result = await createExecutor().execute('Lookpu', { query: 'x' }, {});

    expect(result).toMatchObject({
      success: false,
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        code: TOOL_CALL_ERROR_CODES.unknownTool,
      },
    });
  });

  it.each([
    ['a missing required parameter', {}],
    ['a wrong parameter type', { query: 42 }],
    ['a value outside the schema', { query: 'x', limit: 0 }],
  ])('marks %s as invalid_tool_parameters', async (_case, params) => {
    const execute = vi.fn();
    const result = await createExecutor(execute).execute('Lookup', params, {});

    expect(result).toMatchObject({
      success: false,
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        code: TOOL_CALL_ERROR_CODES.invalidParameters,
        message: expect.stringContaining('Parameter validation failed'),
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not attach a malformed-call code to valid calls', async () => {
    const result = await createExecutor().execute('Lookup', { query: 'x' }, {});

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
