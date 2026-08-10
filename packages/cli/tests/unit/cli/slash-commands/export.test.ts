import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportSessionMarkdown: vi.fn(),
  writeSessionMarkdownExport: vi.fn(),
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    exportSessionMarkdown: mocks.exportSessionMarkdown,
  },
}));

vi.mock('../../../../src/services/SessionExportWriter.js', () => ({
  writeSessionMarkdownExport: mocks.writeSessionMarkdownExport,
}));

import exportCommand from '../../../../src/slash-commands/export.js';

const exported = {
  filename: 'blade-session-session-1.md',
  markdown: '# Blade conversation\n\n## User\n\nhello\n',
  contentSha256: 'a'.repeat(64),
  contentBytes: 20,
  messageCount: 1,
  activityCount: 0,
  reasoningIncluded: false,
  reasoningCount: 0,
  redactionCount: 2,
};

describe('/export slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportSessionMarkdown.mockResolvedValue(exported);
    mocks.writeSessionMarkdownExport.mockResolvedValue(
      '/workspace/blade-session-session-1.md'
    );
  });

  it('writes the current TUI session without overwriting by default', async () => {
    const result = await exportCommand.handler([], {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      sessionId: 'session-1',
      surface: 'tui',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'session_exported',
        contentSha256: exported.contentSha256,
        redactionCount: 2,
      },
    });
    expect(mocks.exportSessionMarkdown).toHaveBeenCalledWith(
      'session-1',
      '/workspace',
      { includeReasoning: false }
    );
    expect(mocks.writeSessionMarkdownExport).toHaveBeenCalledWith(
      '/workspace',
      exported,
      undefined
    );
  });

  it('accepts an explicit path and reasoning opt-in', async () => {
    await exportCommand.handler(['reports/conversation.md', '--reasoning'], {
      cwd: '/workspace',
      sessionId: 'session-1',
      surface: 'tui',
    });

    expect(mocks.exportSessionMarkdown).toHaveBeenCalledWith(
      'session-1',
      '/workspace',
      { includeReasoning: true }
    );
    expect(mocks.writeSessionMarkdownExport).toHaveBeenCalledWith(
      '/workspace',
      exported,
      'reports/conversation.md'
    );
  });

  it('returns bounded Markdown inline for ACP without writing a host path', async () => {
    const result = await exportCommand.handler([], {
      cwd: '/remote/workspace',
      sessionId: 'session-1',
      surface: 'acp',
    });
    expect(result).toMatchObject({
      success: true,
      content: exported.markdown,
      data: {
        filename: exported.filename,
        contentSha256: exported.contentSha256,
      },
    });
    expect(mocks.writeSessionMarkdownExport).not.toHaveBeenCalled();

    await expect(
      exportCommand.handler(['host.md'], {
        cwd: '/remote/workspace',
        sessionId: 'session-1',
        surface: 'acp',
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('does not write host paths'),
    });
  });

  it('fails closed for missing ownership, invalid flags, and oversized ACP output', async () => {
    await expect(exportCommand.handler([], { cwd: '/workspace' })).resolves.toEqual({
      success: false,
      error: 'No active session to export',
    });
    await expect(
      exportCommand.handler(['--force'], {
        cwd: '/workspace',
        sessionId: 'session-1',
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'Unknown export option: --force',
    });

    mocks.exportSessionMarkdown.mockResolvedValueOnce({
      ...exported,
      markdown: 'x'.repeat(1024 * 1024 + 1),
    });
    await expect(
      exportCommand.handler([], {
        cwd: '/remote/workspace',
        sessionId: 'session-1',
        surface: 'acp',
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('ACP inline limit'),
    });
  });
});
