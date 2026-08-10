import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addAssistantMessage: vi.fn(),
  getStatus: vi.fn(),
  trust: vi.fn(),
  revoke: vi.fn(),
  reload: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/security/WorkspaceTrustService.js', () => ({
  WorkspaceTrustService: {
    getInstance: () => ({
      getStatus: mocks.getStatus,
      trust: mocks.trust,
      revoke: mocks.revoke,
    }),
  },
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  sessionActions: () => ({
    addAssistantMessage: mocks.addAssistantMessage,
  }),
}));

vi.mock('../../../../src/security/reloadWorkspaceTrust.js', () => ({
  reloadWorkspaceTrustConfiguration: mocks.reload,
}));

import trustCommand from '../../../../src/slash-commands/trust.js';

const status = {
  projectPath: '/workspace',
  trustRoot: '/workspace',
  state: 'untrusted',
  trusted: false,
  sensitiveSources: 1,
  decision: 'undecided',
  sources: [
    {
      path: '.blade/config.json',
      kind: 'config',
      keys: ['mcpServers'],
      effects: [{ kind: 'mcp', name: 'project', target: 'node server.js' }],
    },
  ],
};

describe('/trust command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue(status);
    mocks.trust.mockResolvedValue({
      ...status,
      state: 'trusted',
      trusted: true,
      decision: 'trusted',
    });
    mocks.revoke.mockResolvedValue({
      ...status,
      decision: 'untrusted',
    });
  });

  it('reviews sensitive sources without mutating trust', async () => {
    const result = await trustCommand.handler(['review'], {
      cwd: '/workspace',
    });

    expect(result.success).toBe(true);
    expect(mocks.getStatus).toHaveBeenCalledWith('/workspace');
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining('node server.js')
    );
    expect(mocks.trust).not.toHaveBeenCalled();
  });

  it('trusts and revokes the exact workspace', async () => {
    await trustCommand.handler(['approve'], { cwd: '/workspace' });
    await trustCommand.handler(['revoke'], { cwd: '/workspace' });

    expect(mocks.trust).toHaveBeenCalledWith('/workspace');
    expect(mocks.revoke).toHaveBeenCalledWith('/workspace');
    expect(mocks.reload).toHaveBeenCalledTimes(2);
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining('重新启动')
    );
  });

  it('projects review output through ACP callbacks', async () => {
    const sendMessage = vi.fn();
    await trustCommand.handler([], {
      cwd: '/workspace',
      acp: { sendMessage },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Workspace Trust')
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
  });
});
