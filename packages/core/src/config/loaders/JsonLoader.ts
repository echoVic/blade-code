/**
 * JSON 配置加载器
 */

import fs from 'fs/promises';
import { ConfigLoader, ConfigLoadResult } from '../types/index.js';

export class JsonLoader implements ConfigLoader {
  async load(configPath: string): Promise<ConfigLoadResult> {
    try {
      // 检查文件是否存在
      try {
        await fs.access(configPath);
      } catch {
        return {
          success: false,
          config: {},
          errors: [`配置文件不存在: ${configPath}`],
          warnings: [],
          loadedFrom: [],
        };
      }

      // 读取文件内容
      const content = await fs.readFile(configPath, 'utf-8');
      
      // 解析 JSON
      const config = JSON.parse(content);
      
      return {
        success: true,
        config,
        errors: [],
        warnings: [],
        loadedFrom: [configPath],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        config: {},
        errors: [`加载配置文件失败: ${errorMessage}`],
        warnings: [],
        loadedFrom: [],
      };
    }
  }
  
  supports(fileExtension: string): boolean {
    return fileExtension === '.json';
  }
}