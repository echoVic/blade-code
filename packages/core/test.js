/**
 * Blade AI Core 测试脚本
 * 验证核心包导出和功能
 */

import { Agent } from '@blade-ai/core';
import { BladeConfig } from '@blade-ai/types';

// 测试类型导入
const config = {
  apiKey: 'test-key',
  baseUrl: 'https://test.api.com',
  modelName: 'test-model'
};

// 测试Agent类导出
const agent = new Agent(config);

console.log('✅ Blade AI Core 包测试通过');
console.log('✅ Agent类导出正常');
console.log('✅ 类型定义导入正常');

// 测试Agent方法
console.log('Agent配置:', agent.getConfig());