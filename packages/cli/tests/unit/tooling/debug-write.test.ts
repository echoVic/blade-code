import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setFileSystemService } from '../../../src/services/FileSystemService.js';
import { writeTool } from '../../../src/tools/builtin/file/write.js';
import { createMockFileSystem } from '../../support/mocks/mockFileSystem.js';

vi.mock('../../../src/acp/AcpServiceContext.js', () => ({
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

    const invocation = writeTool.build({
      file_path: filePath,
      content,
      encoding: 'utf8',
      create_directories: false,
    });
    const result = await invocation.execute(context.signal, context.updateOutput, {
      sessionId: context.sessionId,
      messageId: context.messageId,
    });

    console.log('Result:', JSON.stringify(result, null, 2));
    console.log('Success:', result.success);
    console.log('Metadata:', result.metadata);
    console.log('Error:', result.error);

    expect(result).toBeDefined();
  });
});
