/**
 * Blade AI Core 简单测试脚本
 * 验证基本导出功能
 */

// 测试直接文件导入
import { Agent } from './dist/index.js';

console.log('✅ Blade AI Core 包基础导入测试通过');
console.log('✅ Agent类导出正常');

// 检查Agent类是否存在
console.log('Agent类:', typeof Agent);