/**
 * JSON 配置持久化器
 */

import fs from 'fs/promises';
import { ConfigPersister } from '../types/index.js';

export class JsonPersister implements ConfigPersister {
  async save(config: any, configPath: string): Promise<void> {
    try {
      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(configPath, content, 'utf-8');
    } catch (error) {
      throw new Error(`保存配置文件失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }
  
  supports(fileExtension: string): boolean {
    return fileExtension === '.json';
  }
}