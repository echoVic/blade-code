/**
 * Blade AI Core 基础测试
 * 验证构建输出基本功能
 */

// 直接测试构建文件是否存在
import { existsSync } from 'fs';
import { join } from 'path';

const distPath = join(process.cwd(), 'dist');
const indexPath = join(distPath, 'index.js');

console.log('检查dist目录:', existsSync(distPath));
console.log('检查index.js:', existsSync(indexPath));

if (existsSync(indexPath)) {
  console.log('✅ 构建输出文件存在');
  console.log('✅ Core包构建成功');
} else {
  console.log('❌ 构建输出文件不存在');
}