import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addAssistantMessage: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  trustProject: vi.fn(),
  revokeProjectTrust: vi.fn(),
  getTrustStatus: vi.fn(),
  isEnabled: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => mocks,
  },
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  sessionActions: () => ({
    addAssistantMessage: mocks.addAssistantMessage,
  }),
}));

import hooksCommand from '../../../../src/slash-commands/hooks.js';

describe('/hooks trust commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isEnabled.mockReturnValue(true);
    mocks.getConfig.mockReturnValue({
      enabled: true,
      PreToolUse: [
        {
          hooks: [{ type: 'command', command: 'printf reviewed' }],
        },
      ],
    });
    mocks.getTrustStatus.mockResolvedValue({
      state: 'untrusted',
      currentDigest: 'sha256:current',
    });
    mocks.trustProject.mockResolvedValue({
      state: 'trusted',
      currentDigest: 'sha256:current',
    });
    mocks.revokeProjectTrust.mockResolvedValue({
      state: 'untrusted',
      currentDigest: 'sha256:current',
    });
  });

  it('shows trust state in status output', async () => {
    const result = await hooksCommand.handler(['status'], {
      cwd: '/workspace/project',
    });

    expect(result.success).toBe(true);
    expect(mocks.getTrustStatus).toHaveBeenCalledWith('/workspace/project');
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining('**信任**: untrusted')
    );
  });

  it('trusts and revokes the exact command workspace', async () => {
    await hooksCommand.handler(['trust'], { cwd: '/workspace/project' });
    await hooksCommand.handler(['revoke'], { cwd: '/workspace/project' });

    expect(mocks.trustProject).toHaveBeenCalledWith('/workspace/project');
    expect(mocks.revokeProjectTrust).toHaveBeenCalledWith('/workspace/project');
  });

  it('projects hook trust status through ACP callbacks', async () => {
    const sendMessage = vi.fn();
    await hooksCommand.handler(['status'], {
      cwd: '/workspace/project',
      acp: { sendMessage },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('**信任**: untrusted')
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
  });
});
