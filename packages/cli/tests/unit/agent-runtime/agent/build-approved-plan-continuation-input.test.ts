import { describe, expect, it } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';

describe('buildApprovedPlanContinuationInput', () => {
  it('switches the context mode and appends the approved plan to string messages', async () => {
    const { buildApprovedPlanContinuationInput } = await import(
      '../../../../src/agent/buildApprovedPlanContinuationInput.js'
    );

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.PLAN,
    };

    const continuation = buildApprovedPlanContinuationInput({
      message: 'implement this',
      context: context as any,
      targetMode: PermissionMode.DEFAULT,
      planContent: '1. add helper\n2. run tests',
    });

    expect(continuation.context).toEqual({
      ...context,
      permissionMode: PermissionMode.DEFAULT,
    });
    expect(continuation.message).toContain('implement this');
    expect(continuation.message).toContain('<approved-plan>');
    expect(continuation.message).toContain('1. add helper');
  });

  it('leaves multimodal messages intact except for appending the approved plan text part', async () => {
    const { buildApprovedPlanContinuationInput } = await import(
      '../../../../src/agent/buildApprovedPlanContinuationInput.js'
    );

    const message = [
      { type: 'image_url', image_url: { url: 'https://example.com/ref.png' } },
      { type: 'text', text: 'implement this' },
    ] as const;

    const continuation = buildApprovedPlanContinuationInput({
      message: message as any,
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.PLAN,
      } as any,
      targetMode: PermissionMode.AUTO_EDIT,
      planContent: 'follow the approved plan',
    });

    expect(continuation.context.permissionMode).toBe(PermissionMode.AUTO_EDIT);
    expect(continuation.message).toEqual([
      ...message,
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('follow the approved plan'),
      }),
    ]);
  });
});
