import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../../src/config/types.js';
import { exitPlanModeTool } from '../../../../../../src/tools/builtin/plan/ExitPlanModeTool.js';
import { ToolErrorType } from '../../../../../../src/tools/types/ToolTypes.js';

describe('ExitPlanModeTool', () => {
  it.each([PermissionMode.DEFAULT, PermissionMode.AUTO_EDIT, PermissionMode.YOLO])(
    'rejects an exit request in %s mode before asking for confirmation',
    async (permissionMode) => {
      const requestConfirmation = vi.fn().mockResolvedValue({
        approved: true,
        targetMode: PermissionMode.AUTO_EDIT,
      });

      const result = await exitPlanModeTool.execute(
        { plan: '# stale plan' },
        undefined,
        {
          permissionMode,
          confirmationHandler: { requestConfirmation },
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(ToolErrorType.VALIDATION_ERROR);
      expect(result.llmContent).toContain('not in plan mode');
      expect(requestConfirmation).not.toHaveBeenCalled();
    }
  );

  it('keeps the approval flow available in plan mode', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue({
      approved: true,
      targetMode: PermissionMode.AUTO_EDIT,
    });

    const result = await exitPlanModeTool.execute(
      { plan: '# approved plan' },
      undefined,
      {
        permissionMode: PermissionMode.PLAN,
        confirmationHandler: { requestConfirmation },
      }
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      approved: true,
      shouldExitLoop: true,
      targetMode: PermissionMode.AUTO_EDIT,
      planContent: '# approved plan',
    });
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });
});
