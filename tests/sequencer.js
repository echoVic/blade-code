import type { Test, Context } from 'jest';

import Sequencer from '@jest/test-sequencer';

export default class CustomSequencer extends Sequencer {
  sort(tests: Array<Test>): Array<Test> {
    // 复制测试数组以避免修改原始数组
    const copyTests = [...tests];
    
    // 根据测试类型和重要性排序
    return copyTests.sort((testA, testB) => {
      // 1. 优先运行单元测试（较快）
      const isUnitA = this.isUnitTest(testA.path);
      const isUnitB = this.isUnitTest(testB.path);
      
      if (isUnitA && !isUnitB) return -1;
      if (!isUnitA && isUnitB) return 1;
      
      // 2. 然后运行集成测试
      const isIntegrationA = this.isIntegrationTest(testA.path);
      const isIntegrationB = this.isIntegrationTest(testB.path);
      
      if (isIntegrationA && !isIntegrationB) return -1;
      if (!isIntegrationA && isIntegrationB) return 1;
      
      // 3. 最后运行端到端测试（最慢）
      const isE2EA = this.isE2ETest(testA.path);
      const isE2EB = this.isE2ETest(testB.path);
      
      if (isE2EA && !isE2EB) return 1;
      if (!isE2EA && isE2EB) return -1;
      
      // 4. 对于相同类型的测试，根据文件路径排序
      return testA.path.localeCompare(testB.path);
    });
  }
  
  private isUnitTest(path: string): boolean {
    return path.includes('/unit/') || path.includes('__tests__/') || path.includes('.unit.');
  }
  
  private isIntegrationTest(path: string): boolean {
    return path.includes('/integration/') || path.includes('.integration.');
  }
  
  private isE2ETest(path: string): boolean {
    return path.includes('/e2e/') || path.includes('.e2e.');
  }
}