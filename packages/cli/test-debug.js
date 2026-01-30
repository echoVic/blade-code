/**
 * 调试脚本 - 了解 MockFileSystem 和 readTool 的交互
 */

import { readTool } from './src/tools/builtin/file/read.js';
import { createMockFileSystem } from './tests/mocks/mockFileSystem.js';
import { getFileSystemService, setFileSystemService } from './src/services/FileSystemService.js';
import { FileAccessTracker } from './src/tools/builtin/file/FileAccessTracker.js';

async function main() {
  console.log('=== 调试开始 ===\n');

  // 创建 mock 文件系统
  const mockFS = createMockFileSystem();

  // 替换为 mock 文件系统
  setFileSystemService(mockFS);

  // 设置测试文件
  const filePath = '/tmp/test.txt';
  const content = 'Hello, World!';
  mockFS.setFile(filePath, content);

  console.log('1. MockFileSystem 文件设置:');
  console.log(`   - 文件路径: ${filePath}`);
  console.log(`   - 文件内容: ${content}`);

  console.log('\n2. 测试文件是否存在:');
  const exists = await mockFS.exists(filePath);
  console.log(`   - exists('${filePath}'): ${exists}`);

  console.log('\n3. 测试文件统计:');
  const stats = await mockFS.stat(filePath);
  console.log(`   - stats:`, JSON.stringify(stats, null, 2));

  console.log('\n4. 测试读取文本文件:');
  try {
    const fileContent = await mockFS.readTextFile(filePath);
    console.log(`   - 内容: ${fileContent}`);
  } catch (error) {
    console.log(`   - 错误:`, error);
  }

  console.log('\n5. 测试 getFileSystemService:');
  const fsService = getFileSystemService();
  console.log(`   - fsService instance: ${fsService.constructor.name}`);
  console.log(`   - 是否为 mockFS: ${fsService === mockFS}`);

  console.log('\n6. 测试通过 FileSystemService 读取:');
  try {
    const fsContent = await fsService.readTextFile(filePath);
    console.log(`   - 内容: ${fsContent}`);
  } catch (error) {
    console.log(`   - 错误:`, error);
  }

  console.log('\n7. 重置 FileAccessTracker:');
  FileAccessTracker.resetInstance();

  console.log('\n8. 测试 readTool.execute:');
  const context = {
    sessionId: 'test-session',
    updateOutput: (msg) => console.log(`   [updateOutput] ${msg}`),
    signal: new AbortController().signal,
  };

  try {
    const result = await readTool.execute(
      {
        file_path: filePath,
      },
      context
    );
    console.log(`   - success: ${result.success}`);
    console.log(`   - llmContent: ${result.llmContent}`);
    console.log(`   - displayContent: ${result.displayContent}`);
    console.log(`   - metadata:`, result.metadata);
    if (result.error) {
      console.log(`   - error:`, result.error);
    }
  } catch (error) {
    console.log(`   - 异常:`, error);
  }

  console.log('\n=== 调试结束 ===');
}

main().catch(console.error);
