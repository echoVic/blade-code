export { AutoMemoryManager } from './AutoMemoryManager.js';
export type {
  MemoryConsolidationEntry,
  MemoryConsolidationPlan,
} from './MemoryConsolidation.js';
export type {
  MemoryConsolidationProjection,
  MemoryConsolidationTopic,
} from '../api/memoryConsolidationSchemas.js';
export {
  commitMemoryConsolidation,
  EMPTY_MEMORY_CONSOLIDATION_PLAN,
  planMemoryConsolidation,
} from './MemoryConsolidation.js';
export type { MemorySafetyResult } from './MemorySafety.js';
export { classifyMemoryContent } from './MemorySafety.js';
export type { AutoMemoryConfig, MemoryTopicInfo } from './types.js';
export { DEFAULT_AUTO_MEMORY_CONFIG } from './types.js';
