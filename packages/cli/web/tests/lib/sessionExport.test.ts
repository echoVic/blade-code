// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  exportSessionMarkdown: vi.fn(),
}));

vi.mock('../../src/services', () => ({
  sessionService: {
    exportSessionMarkdown: serviceMocks.exportSessionMarkdown,
  },
}));

import { downloadSessionMarkdown } from '../../src/lib/sessionExport';

describe('downloadSessionMarkdown', () => {
  const ref = { sessionId: 'session-1', projectPath: '/workspace/a' };
  const exported = {
    filename: 'blade-session-session-1.md',
    markdown: '# Blade conversation\n',
    contentSha256: 'a'.repeat(64),
    messageCount: 1,
    activityCount: 2,
    redactionCount: 3,
  };
  let click: ReturnType<typeof vi.spyOn>;
  let createObjectUrl: ReturnType<typeof vi.fn>;
  let revokeObjectUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    serviceMocks.exportSessionMarkdown.mockReset();
    serviceMocks.exportSessionMarkdown.mockResolvedValue(exported);
    createObjectUrl = vi.fn(() => 'blob:session-export');
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    click.mockRestore();
  });

  it('downloads the exact Markdown filename and revokes the object URL', async () => {
    const result = await downloadSessionMarkdown(ref, true);

    expect(result).toEqual(exported);
    expect(serviceMocks.exportSessionMarkdown).toHaveBeenCalledWith(ref, true);
    expect(createObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text/markdown;charset=utf-8' })
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:session-export');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('does not create a download when the service rejects', async () => {
    serviceMocks.exportSessionMarkdown.mockRejectedValueOnce(
      new Error('export failed')
    );
    await expect(downloadSessionMarkdown(ref)).rejects.toThrow('export failed');
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
