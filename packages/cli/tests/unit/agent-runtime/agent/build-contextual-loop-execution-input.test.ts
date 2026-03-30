import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildDefaultLoopExecutionInputMock, buildPlanLoopExecutionInputMock, buildSpecLoopExecutionInputMock, loadSpecLoopContextMock } =
  vi.hoisted(() => ({
    buildDefaultLoopExecutionInputMock: vi.fn(),
    buildPlanLoopExecutionInputMock: vi.fn(),
    buildSpecLoopExecutionInputMock: vi.fn(),
    loadSpecLoopContextMock: vi.fn(),
  }));

vi.mock('../../../../src/agent/buildDefaultLoopExecutionInput.js', () => ({
  buildDefaultLoopExecutionInput: buildDefaultLoopExecutionInputMock,
}));

vi.mock('../../../../src/agent/buildPlanLoopExecutionInput.js', () => ({
  buildPlanLoopExecutionInput: buildPlanLoopExecutionInputMock,
}));

vi.mock('../../../../src/agent/buildSpecLoopExecutionInput.js', () => ({
  buildSpecLoopExecutionInput: buildSpecLoopExecutionInputMock,
}));

vi.mock('../../../../src/agent/loadSpecLoopContext.js', () => ({
  loadSpecLoopContext: loadSpecLoopContextMock,
}));

describe('buildContextualLoopExecutionInput', () => {
  beforeEach(() => {
    buildDefaultLoopExecutionInputMock.mockReset();
    buildPlanLoopExecutionInputMock.mockReset();
    buildSpecLoopExecutionInputMock.mockReset();
    loadSpecLoopContextMock.mockReset();
  });

  it('selects the plan-mode builder when permissionMode is plan', async () => {
    const executionInput = { message: 'plan-message', systemPrompt: 'plan-system' };
    buildPlanLoopExecutionInputMock.mockResolvedValue(executionInput);

    const { buildContextualLoopExecutionInput } = await import(
      '../../../../src/agent/buildContextualLoopExecutionInput.js'
    );

    const result = await buildContextualLoopExecutionInput({
      message: 'hello',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: '/workspace/project',
        permissionMode: 'plan',
      } as any,
      runtimeOptions: {},
      language: 'zh-CN',
      environmentContext: 'ENV',
      specManager: {} as any,
      onSpecInitializationWarning: vi.fn(),
    });

    expect(buildPlanLoopExecutionInputMock).toHaveBeenCalledWith({
      message: 'hello',
      language: 'zh-CN',
    });
    expect(result).toBe(executionInput);
  });

  it('loads spec context and selects the spec-mode builder when permissionMode is spec', async () => {
    loadSpecLoopContextMock.mockResolvedValue({
      currentSpec: { id: 'spec-1', phase: 'design' },
      steeringContext: 'steering',
    });
    const executionInput = { message: 'spec-message', systemPrompt: 'spec-system' };
    buildSpecLoopExecutionInputMock.mockReturnValue(executionInput);

    const { buildContextualLoopExecutionInput } = await import(
      '../../../../src/agent/buildContextualLoopExecutionInput.js'
    );

    const specManager = { initialize: vi.fn(), getCurrentSpec: vi.fn(), getSteeringContextString: vi.fn() };
    const onSpecInitializationWarning = vi.fn();

    const result = await buildContextualLoopExecutionInput({
      message: 'hello',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: '/workspace/project',
        permissionMode: 'spec',
      } as any,
      runtimeOptions: {},
      language: 'zh-CN',
      environmentContext: 'ENV',
      specManager: specManager as any,
      onSpecInitializationWarning,
    });

    expect(loadSpecLoopContextMock).toHaveBeenCalledWith({
      specManager,
      workspaceRoot: '/workspace/project',
      onInitializationWarning: onSpecInitializationWarning,
    });
    expect(buildSpecLoopExecutionInputMock).toHaveBeenCalledWith({
      message: 'hello',
      currentSpec: { id: 'spec-1', phase: 'design' },
      steeringContext: 'steering',
    });
    expect(result).toBe(executionInput);
  });

  it('falls back to the default-mode builder for other permission modes', async () => {
    const executionInput = { message: 'default-message', systemPrompt: 'default-system' };
    buildDefaultLoopExecutionInputMock.mockResolvedValue(executionInput);

    const { buildContextualLoopExecutionInput } = await import(
      '../../../../src/agent/buildContextualLoopExecutionInput.js'
    );

    const result = await buildContextualLoopExecutionInput({
      message: 'hello',
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: '/workspace/project',
        systemPrompt: 'context-system',
        permissionMode: 'default',
      } as any,
      runtimeOptions: {
        systemPrompt: 'runtime-system',
        appendSystemPrompt: 'runtime-append',
      },
      language: 'zh-CN',
      environmentContext: 'ENV',
      specManager: {} as any,
      onSpecInitializationWarning: vi.fn(),
    });

    expect(buildDefaultLoopExecutionInputMock).toHaveBeenCalledWith({
      message: 'hello',
      contextSystemPrompt: 'context-system',
      runtimeSystemPrompt: 'runtime-system',
      runtimeAppendSystemPrompt: 'runtime-append',
      language: 'zh-CN',
      environmentContext: 'ENV',
    });
    expect(result).toBe(executionInput);
  });
});
