/**
 * 深度合并策略实现
 */

import { ConfigMergeStrategy } from '../types/index.js';

export class DeepMergeStrategy implements ConfigMergeStrategy {
  merge(target: any, source: any, options: any = {}): any {
    const { arrayMergeStrategy = 'replace' } = options;
    
    // 如果source是null或undefined，返回target
    if (source === null || source === undefined) {
      return target;
    }
    
    // 如果target是null或undefined，返回source
    if (target === null || target === undefined) {
      return source;
    }
    
    // 处理数组
    if (Array.isArray(target) && Array.isArray(source)) {
      switch (arrayMergeStrategy) {
        case 'replace':
          return [...source];
        case 'concat':
          return [...target, ...source];
        case 'merge':
          return this.mergeArrays(target, source);
        default:
          return [...source];
      }
    }
    
    // 处理对象
    if (typeof target === 'object' && typeof source === 'object' && 
        !Array.isArray(target) && !Array.isArray(source)) {
      const result = { ...target };
      
      for (const key in source) {
        if (source.hasOwnProperty(key)) {
          result[key] = this.merge(target[key], source[key], options);
        }
      }
      
      return result;
    }
    
    // 基础类型或无法合并的情况，返回source
    return source;
  }
  
  canMerge(target: any, source: any): boolean {
    // 只允许合并对象或数组
    return (typeof target === 'object' || Array.isArray(target)) &&
           (typeof source === 'object' || Array.isArray(source));
  }
  
  /**
   * 合并两个数组（基于唯一标识符）
   */
  private mergeArrays(target: any[], source: any[]): any[] {
    const result = [...target];
    
    for (const sourceItem of source) {
      // 尝试找到匹配的项
      const index = this.findIndex(result, sourceItem);
      
      if (index !== -1) {
        // 合并匹配的项
        result[index] = this.merge(result[index], sourceItem);
      } else {
        // 添加新项
        result.push(sourceItem);
      }
    }
    
    return result;
  }
  
  /**
   * 查找数组项的索引
   */
  private findIndex(array: any[], item: any): number {
    // 尝试基于id属性匹配
    if (item.id !== undefined) {
      return array.findIndex(i => i.id === item.id);
    }
    
    // 尝试基于name属性匹配
    if (item.name !== undefined) {
      return array.findIndex(i => i.name === item.name);
    }
    
    // 尝试基于key属性匹配
    if (item.key !== undefined) {
      return array.findIndex(i => i.key === item.key);
    }
    
    // 基于字符串表示匹配
    return array.findIndex(i => JSON.stringify(i) === JSON.stringify(item));
  }
}