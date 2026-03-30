import { beforeEach, describe, expect, it, vi } from 'vitest';

const { injectSkillsMetadataMock, loggerDebugMock } = vi.hoisted(() => ({
  injectSkillsMetadataMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('../../../../src/skills/index.js', () => ({
  injectSkillsMetadata: injectSkillsMetadataMock,
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: loggerDebugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));

import { PermissionMode } from '../../../../src/config/types.js';
import { initializeAgentLoopRuntime } from '../../../../src/agent/initializeAgentLoopRuntime.js';

describe('initializeAgentLoopRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects skill metadata before applying tool restrictions and logs readonly tools in plan mode', () => {
    const rawTools = [{ name: 'Read' }, { name: 'Edit' }] as any;
    const injectedTools = [{ name: 'Read', description: 'with metadata' }, { name: 'Edit' }] as any;
    const filteredTools = [{ name: 'Read', description: 'with metadata' }] as any;
    const applySkillToolRestrictions = vi.fn((tools) => {
      expect(tools).toBe(injectedTools);
      return filteredTools;
    });

    injectSkillsMetadataMock.mockReturnValue(injectedTools);

    const runtime = initializeAgentLoopRuntime({
      context: {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        permissionMode: PermissionMode.PLAN,
      },
      options: { maxTurns: 7 },
      dependencies: {
        config: {
          maxTurns: 20,
          debug: false,
        } as any,
        runtimeOptions: {},
        executionPipeline: {
          getRegistry: () => ({
            getFunctionDeclarationsByMode: vi.fn(() => rawTools),
            getReadOnlyTools: vi.fn(() => [{ name: 'Read' }]),
            get: vi.fn(),
          }),
        } as any,
        applySkillToolRestrictions,
      },
    });

    expect(injectSkillsMetadataMock).toHaveBeenCalledWith(rawTools);
    expect(applySkillToolRestrictions).toHaveBeenCalledOnce();
    expect(runtime.tools).toBe(filteredTools);
    expect(runtime.loopControl).toMatchObject({
      configuredMaxTurns: 7,
      actualMaxTurns: 7,
      isYoloMode: false,
    });
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '🔒 Plan mode: 使用只读工具 (1 个): Read'
    );
  });
});
