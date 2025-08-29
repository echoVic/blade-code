/**
 * Zod 验证器实现
 */

import { ConfigValidator } from '../types/index.js';
import { z } from 'zod';

export class ZodValidation implements ConfigValidator {
  validate(config: any, schema: z.ZodSchema<any>): { valid: boolean; errors: string[] } {
    try {
      schema.parse(config);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map(err => 
          `${err.path.join('.')}: ${err.message}`
        );
        return { valid: false, errors };
      }
      return { 
        valid: false, 
        errors: [`验证失败: ${error instanceof Error ? error.message : '未知错误'}`] 
      };
    }
  }
}