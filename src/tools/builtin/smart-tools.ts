import type { ToolDefinition } from '../types.js';
import { smartCodeReview, smartDocGenerator } from './smart/index.js';

/**
 * 智能工具集合
 * 基于LLM增强的高级功能工具
 */
export const smartTools: ToolDefinition[] = [smartCodeReview, smartDocGenerator];
