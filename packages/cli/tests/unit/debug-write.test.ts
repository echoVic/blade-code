import { describe, expect, it, beforeEach, vi } from 'vitest';
import { writeTool } from '../../src/tools/builtin/file/write.js';
import { createMockFileSystem } from '../mocks/mockFileSystem.js';
import { getFileSystemService, setFileSystemService } from '../../src/services/FileSystemService.js';

vi.mock('../../src/acp/AcpServiceContext.js', () => ({
  isAcpMode: vi.fn(() => false),
}));

describe('Debug WriteTool', () => {
  let mockFS: ReturnType<typeof createMockFileSystem>;

  beforeEach(() => {
    mockFS = createMockFileSystem();
    setFileSystemService(mockFS as any);
  });

  it('should write a simple file', async () => {
    const filePath = '/tmp/test.txt';
    const content = 'Hello, World!';

    const context = {
      sessionId: 'test-session',
      messageId: 'msg-123',
      updateOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    const result = await writeTool.execute(
      {
        file_path: filePath,
        content,
      },
      context
    );

    console.log('Result:', JSON.stringify(result, null, 2));
    console.log('Success:', result.success);
    console.log('Metadata:', result.metadata);
    console.log('Error:', result.error);

    expect(result).toBeDefined();
  });
});
