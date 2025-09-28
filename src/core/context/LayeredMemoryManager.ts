/**
 * 内存分层管理系统
 * 实现短期、中期、长期内存分层管理
 */

import { EventEmitter } from 'events';
import { ErrorFactory } from '../error/index.js';

export enum MemoryLayer {
  SHORT_TERM = 'short_term',
  MEDIUM_TERM = 'medium_term',
  LONG_TERM = 'long_term',
}

export interface ConversationContext {
  messages: Array<{
    role: string;
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }>;
  contextId: string;
  metadata: {
    duration: number;
    turnCount: number;
    startTime: number;
    endTime?: number;
  };
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  startTime: number;
  lastAccess: number;
  contexts: string[]; // 会话包含的对话上下文ID列表
  summary: string;
  preferences: Record<string, unknown>;
  statistics: {
    totalMessages: number;
    totalTurns: number;
    averageResponseTime: number;
  };
}

export interface PersistentKnowledge {
  id: string;
  type: 'concept' | 'pattern' | 'user_preference' | 'system_config';
  content: Record<string, unknown>;
  relevance: number;
  confidence: number;
  lastUpdated: number;
  usageCount: number;
  tags: string[];
  connections: string[]; // 关联的其他知识项ID
}

export interface ContextData {
  id: string;
  type: MemoryLayer;
  data: ConversationContext | SessionContext | PersistentKnowledge;
  timestamp: number;
  tags: string[];
  accessCount: number;
  priority: number;
  size: number;
  ttl?: number; // time to live
}

export interface LayeredMemoryConfig {
  shortTerm: {
    maxSize: number; // 最大条目数
    maxDuration: number; // 最大持续时间（ms）
    cleanupInterval: number; // 清理间隔（ms）
  };
  mediumTerm: {
    maxSize: number;
    maxDuration: number;
    persistenceEnabled: boolean;
    compressionEnabled: boolean;
    cleanupInterval: number;
  };
  longTerm: {
    indexingEnabled: boolean;
    embeddingEnabled: boolean;
    searchEnabled: boolean;
    maxStorageSize: number; // MB
  };
  global: {
    enableCompression: boolean;
    enableDedup: boolean;
    enableIndexing: boolean;
  };
}

export interface MigrationStrategy {
  shortToMedium: {
    condition: (data: ContextData) => boolean;
    transform: (data: ContextData) => ContextData;
  };
  mediumToLong: {
    condition: (data: ContextData) => boolean;
    summary: (data: ContextData) => string;
    extract: (data: ContextData) => PersistentKnowledge[];
  };
}

export interface SearchQuery {
  query: string;
  layer?: MemoryLayer;
  tags?: string[];
  minRelevance?: number;
  maxResults?: number;
  timeRange?: {
    start: number;
    end: number;
  };
}

export interface SearchResult {
  item: ContextData;
  score: number;
  layer: MemoryLayer;
  highlighted: string[];
}

/**
 * 短期内存存储 - 当前对话上下文
 */
class ShortTermMemory {
  private contexts = new Map<string, ContextData>();
  private accessOrder: string[] = []; // LRU 访问顺序
  private readonly maxSize: number;
  private readonly maxDuration: number;

  constructor(maxSize: number, maxDuration: number) {
    this.maxSize = maxSize;
    this.maxDuration = maxDuration;
  }

  async store(data: ContextData): Promise<void> {
    const now = Date.now();
    
    // 检查TTL
    if (data.ttl && now > data.timestamp + data.ttl) {
      return; // 已过期，直接丢弃
    }

    // 清理过期数据
    await this.cleanupExpired();

    // 如果超出最大容量，移除最久未使用的数据
    if (this.contexts.size >= this.maxSize) {
      const leastUsed = this.accessOrder[0];
      await this.remove(leastUsed);
    }

    // 存储数据
    this.contexts.set(data.id, data);
    this.accessOrder.push(data.id);
    
    this.updateAccessOrder(data.id);
  }

  async retrieve(id: string): Promise<ContextData | undefined> {
    const data = this.contexts.get(id);
    
    if (!data) {
      return undefined;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - data.timestamp > this.maxDuration) {
      await this.remove(id);
      return undefined;
    }

    // 更新访问统计
    data.accessCount++;
    data.lastUpdated = now;
    this.updateAccessOrder(id);

    return data;
  }

  async remove(id: string): Promise<void> {
    this.contexts.delete(id);
    const index = this.accessOrder.indexOf(id);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  async getAll(): Promise<ContextData[]> {
    const now = Date.now();
    const result: ContextData[] = [];

    for (const [id, data] of this.contexts) {
      if (now - data.timestamp <= this.maxDuration) {
        result.push(data);
      } else {
        await this.remove(id);
      }
    }

    return result;
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, data] of this.contexts) {
      if (now - data.timestamp > this.maxDuration || 
          (data.ttl && now > data.timestamp + data.ttl)) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      await this.remove(id);
    }
  }

  private updateAccessOrder(id: string): void {
    const index = this.accessOrder.indexOf(id);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(id); // 移动到末尾（最近使用）
  }

  clear(): void {
    this.contexts.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.contexts.size;
  }
}

/**
 * 中期内存存储 - 会话级别上下文
 */
class MediumTermMemory {
  private sessions = new Map<string, ContextData>();
  private readonly persistenceEnabled: boolean;
  private readonly compressionEnabled: boolean;

  constructor(persistenceEnabled = true, compressionEnabled = true) {
    this.persistenceEnabled = persistenceEnabled;
    this.compressionEnabled = compressionEnabled;
  }

  async persist(data: ContextData): Promise<void> {
    // 压缩数据（如果启用）
    let processedData = data;
    if (this.compressionEnabled) {
      processedData = await this.compressData(data);
    }

    this.sessions.set(data.id, processedData);

    // 持久化（如果启用）
    if (this.persistenceEnabled) {
      await this.persistToDisk(processedData);
    }
  }

  async retrieveSession(sessionId: string): Promise<ContextData | undefined> {
    const data = this.sessions.get(sessionId);
    
    if (!data) {
      // 尝试从磁盘加载
      if (this.persistenceEnabled) {
        return await this.loadFromDisk(sessionId);
      }
      return undefined;
    }

    // 解压数据
    let processedData = data;
    if (this.compressionEnabled) {
      processedData = await this.decompressData(data);
    }

    return processedData;
  }

  async updateSession(sessionId: string, updates: Partial<ContextData>): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const updated = { ...existing, ...updates, lastUpdated: Date.now() };
      await this.persist(updated);
    }
  }

  async getUserSessions(userId: string): Promise<ContextData[]> {
    const userSessions: ContextData[] = [];
    
    for (const session of this.sessions.values()) {
      if (session.type === MemoryLayer.MEDIUM_TERM) {
        const sessionData = session.data as SessionContext;
        if (sessionData.userId === userId) {
          userSessions.push(session);
        }
      }
    }

    return userSessions.sort((a, b) => b.timestamp - a.timestamp);
  }

  private async compressData(data: ContextData): Promise<ContextData> {
    // 简单的JSON压缩和截断
    if (data.size > 1000) { // 如果数据较大，进行压缩
      const compressed = {
        ...data,
        metadata: {
          ...data.metadata,
          compressed: true,
          originalSize: data.size,
        },
      };
      return compressed;
    }
    return data;
  }

  private async decompressData(data: ContextData): Promise<ContextData> {
    // 恢复压缩的数据
    if (data.metadata?.compressed) {
      return {
        ...data,
        metadata: {
          ...data.metadata,
          decompressed: true,
        },
      };
    }
    return data;
  }

  private async persistToDisk(data: ContextData): Promise<void> {
    // 实际实现应该写入文件系统或数据库
    // 这里只是模拟持久化
    const key = `medium_${data.id}`;
    localStorage.setItem(key, JSON.stringify(data));
  }

  private async loadFromDisk(sessionId: string): Promise<ContextData | undefined> {
    const key = `medium_${sessionId}`;
    const serialized = localStorage.getItem(key);
    
    if (serialized) {
      return JSON.parse(serialized) as ContextData;
    }
    return undefined;
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * 长期内存存储 - 持久化知识库
 */
class LongTermMemory {
  private knowledge = new Map<string, ContextData>();
  private embeddings = new Map<string, number[]>(); // 向量嵌入
  private index = new Map<string, string[]>(); // 搜索索引
  private readonly maxStorageSize: number; // MB
  private storage = 0;

  constructor(maxStorageSize = 1000) { // 1GB 默认限制
    this.maxStorageSize = maxStorageSize;
  }

  async index(data: PersistentKnowledge): Promise<void> {
    const contextData: ContextData = {
      id: data.id,
      type: MemoryLayer.LONG_TERM,
      data,
      timestamp: Date.now(),
      tags: data.tags,
      accessCount: 0,
      priority: Math.floor(data.relevance * 100),
      size: JSON.stringify(data).length,
    };

    // 检查存储限制
    if (this.storage + contextData.size > this.maxStorageSize * 1024 * 1024) {
      // 需要清理或拒绝
      await this.cleanupByLowestRelevance();
    }

    // 存储知识
    this.knowledge.set(data.id, contextData);
    this.storage += contextData.size;

    // 创建嵌入（如果可能）
    if (this.canCreateEmbedding(data)) {
      const embedding = await this.createEmbedding(data);
      this.embeddings.set(data.id, embedding);
    }

    // 更新索引
    await this.updateIndex(data);

    // 管理连接关系
    await this.manageConnections(data);
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    let candidates: ContextData[] = [];

    // 基于标签过滤
    if (query.tags && query.tags.length > 0) {
      candidates = Array.from(this.knowledge.values()).filter(item =>
        query.tags!.some(tag => item.tags.includes(tag))
      );
    } else {
      candidates = Array.from(this.knowledge.values());
    }

    // 基于时间范围过滤
    if (query.timeRange) {
      candidates = candidates.filter(item =>
        item.timestamp >= query.timeRange!.start &&
        item.timestamp <= query.timeRange!.end
      );
    }

    // 评分和排序
    const scoredResults: SearchResult[] = candidates.map(item => {
      const knowledge = item.data as PersistentKnowledge;
      
      // 基础评分
      let score = knowledge.relevance * knowledge.confidence;

      // 时间衰减
      const age = Date.now() - item.lastUpdated;
      const timeDecay = Math.exp(-age / (30 * 24 * 60 * 60 * 1000)); // 30天衰减
      score *= timeDecay;

      // 使用频率加成
      score *= (1 + Math.log10(1 + item.accessCount));

      // 查询匹配评分
      if (query.query) {
        const matchScore = this.calculateQueryMatch(query.query, knowledge);
        score *= matchScore;
      }

      return {
        item,
        score,
        layer: MemoryLayer.LONG_TERM,
        highlighted: this.extractRelevantParts(query.query, knowledge),
      };
    });

    // 排序并限制结果数量
    return scoredResults
      .filter(result => result.score >= (query.minRelevance || 0.1))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.maxResults || 10);
  }

  private canCreateEmbedding(data: PersistentKnowledge): boolean {
    return data.type === 'concept' && data.content.text && typeof data.content.text === 'string';
  }

  private async createEmbedding(data: PersistentKnowledge): Promise<number[]> {
    // 实际的向量嵌入需要通过外部服务或模型生成
    // 这里只是模拟实现
    const text = String(data.content.text || '');
    const embedding = new Array(64).fill(0).map(() => Math.random());
    return embedding;
  }

  private async updateIndex(data: PersistentKnowledge): Promise<void> {
    // 基于内容进行索引
    const text = JSON.stringify(data.content).toLowerCase();
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const uniqueWords = [...new Set(words)];

    for (const word of uniqueWords) {
      if (!this.index.has(word)) {
        this.index.set(word, []);
      }
      this.index.get(word)!.push(data.id);
    }
  }

  private async manageConnections(data: PersistentKnowledge): Promise<void> {
    // 管理知识项之间的关联
    if (data.connections) {
      for (const connectionId of data.connections) {
        const connected = this.knowledge.get(connectionId);
        if (connected) {
          const connectedData = connected.data as PersistentKnowledge;
          if (!connectedData.connections.includes(data.id)) {
            connectedData.connections.push(data.id);
          }
        }
      }
    }
  }

  private calculateQueryMatch(query: string, knowledge: PersistentKnowledge): number {
    const queryLower = query.toLowerCase();
    const contentText = JSON.stringify(knowledge.content).toLowerCase();
    
    // 简单的词频匹配
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    let matchCount = 0;
    
    for (const word of queryWords) {
      if (contentText.includes(word)) {
        matchCount++;
      }
    }
    
    return matchCount / queryWords.length;
  }

  private extractRelevantParts(query: string | undefined, knowledge: PersistentKnowledge): string[] {
    // 提取与查询相关的内容片段
    if (!query) return [];
    
    const content = JSON.stringify(knowledge.content);
    const queryLower = query.toLowerCase();
    
    // 找到包含查询词的片段
    const sentences = content.split(/[.!?]。！？/);
    const relevantSentences = sentences.filter(sentence =>
      sentence.toLowerCase().includes(queryLower)
    );
    
    return relevantSentences.slice(0, 3);
  }

  private async cleanupByLowestRelevance(): Promise<void> {
    // 删除最低相关性的知识项
    const allKnowledge = Array.from(this.knowledge.values());
    const sorted = allKnowledge.sort((a, b) => a.priority - b.priority);
    
    if (sorted.length > 0) {
      const toRemove = sorted[0];
      this.knowledge.delete(toRemove.id);
      this.embeddings.delete(toRemove.id);
      this.storage -= toRemove.size;
    }
  }

  clear(): void {
    this.knowledge.clear();
    this.embeddings.clear();
    this.index.clear();
    this.storage = 0;
  }
}

/**
 * 分层内存管理器
 */
export class LayeredMemoryManager extends EventEmitter {
  private shortTermMemory: ShortTermMemory;
  private mediumTermMemory: MediumTermMemory;
  private longTermMemory: LongTermMemory;
  private config: LayeredMemoryConfig;
  private migrationStrategy: MigrationStrategy;
  private isInitialized = false;
  private cleanupInterval?: NodeJS.Timeout;
  private migrationInterval?: NodeJS.Timeout;

  constructor(config: Partial<LayeredMemoryConfig> = {}) {
    super();

    this.config = {
      shortTerm: {
        maxSize: 100,
        maxDuration: 5 * 60 * 1000, // 5分钟
        cleanupInterval: 60 * 1000, // 1分钟
        ...config.shortTerm,
      },
      mediumTerm: {
        maxSize: 1000,
        maxDuration: 24 * 60 * 60 * 1000, // 24小时
        persistenceEnabled: true,
        compressionEnabled: true,
        cleanupInterval: 60 * 60 * 1000, // 1小时
        ...config.mediumTerm,
      },
      longTerm: {
        indexingEnabled: true,
        embeddingEnabled: false,
        searchEnabled: true,
        maxStorageSize: 100, // 100MB
        ...config.longTerm,
      },
      global: {
        enableCompression: true,
        enableDedup: true,
        enableIndexing: true,
        ...config.global,
      },
    };

    this.shortTermMemory = new ShortTermMemory(
      this.config.shortTerm.maxSize,
      this.config.shortTerm.maxDuration
    );

    this.mediumTermMemory = new MediumTermMemory(
      this.config.mediumTerm.persistenceEnabled,
      this.config.mediumTerm.compressionEnabled
    );

    const maxLongTermStorage = this.config.longTerm.maxStorageSize || 1000;
    this.longTermMemory = new LongTermMemory(maxLongTermStorage);

    this.migrationStrategy = this.initializeMigrationStrategy();
  }

  /**
   * 初始化内存分层管理器
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化分层内存管理器...');

      // 启动定期清理
      this.startCleanupScheduler();

      // 启动数据迁移调度
      this.startMigrationScheduler();

      this.isInitialized = true;
      this.emit('initialized');
      this.log('分层内存管理器初始化完成');
    } catch (error) {
      this.error('初始化失败', error as Error);
      throw error;
    }
  }

  /**
   * 存储上下文数据到指定层级
   */
  public async storeContext(data: ContextData, layer: MemoryLayer): Promise<void> {
    try {
      switch (layer) {
        case MemoryLayer.SHORT_TERM:
          if (data.type !== MemoryLayer.SHORT_TERM) {
            data = this.convertToLayer(data, MemoryLayer.SHORT_TERM);
          }
          await this.shortTermMemory.store(data);
          this.emit('contextStored', { layer, contextId: data.id, data });
          break;
        
        case MemoryLayer.MEDIUM_TERM:
          if (data.type !== MemoryLayer.MEDIUM_TERM) {
            data = this.convertToLayer(data, MemoryLayer.MEDIUM_TERM);
          }
          await this.mediumTermMemory.persist(data);
          this.emit('contextStored', { layer, contextId: data.id, data });
          break;
        
        case MemoryLayer.LONG_TERM:
          if (data.type !== MemoryLayer.LONG_TERM) {
            throw new Error('长期内存只支持存储知识类型数据');
          }
          const knowledge = data.data as PersistentKnowledge;
          await this.longTermMemory.index(knowledge);
          this.emit('contextStored', { layer, contextId: data.id, knowledge });
          break;
        
        default:
          throw new Error(`未知内存层级: ${layer}`);
      }
    } catch (error) {
      this.error(`存储上下文失败 (${layer})`, error as Error);
      throw error;
    }
  }

  /**
   * 从指定层级检索上下文数据
   */
  public async retrieveContext(contextId: string, layer?: MemoryLayer): Promise<ContextData | undefined> {
    try {
      // 如果指定了层级，只在该层级查找
      if (layer) {
        return await this.retrieveFromLayer(contextId, layer);
      }

      // 否则按层级顺序查找
      for (const searchLayer of [MemoryLayer.SHORT_TERM, MemoryLayer.MEDIUM_TERM, MemoryLayer.LONG_TERM]) {
        const result = await this.retrieveFromLayer(contextId, searchLayer);
        if (result) {
          this.emit('contextRetrieved', { contextId, layer: searchLayer, data: result });
          return result;
        }
      }

      return undefined;
    } catch (error) {
      this.error(`检索上下文失败`, error as Error);
      throw error;
    }
  }

  /**
   * 从特定层级检索数据
   */
  private async retrieveFromLayer(contextId: string, layer: MemoryLayer): Promise<ContextData | undefined> {
    switch (layer) {
      case MemoryLayer.SHORT_TERM:
        return await this.shortTermMemory.retrieve(contextId);
      
      case MemoryLayer.MEDIUM_TERM:
        // 解析会话ID
        const sessionData = await this.mediumTermMemory.retrieveSession(contextId);
        if (sessionData) {
          return sessionData;
        }
        break;
      
      case MemoryLayer.LONG_TERM:
        // 需要在长期内存中搜索
        const searchResults = await this.longTermMemory.search({
          query: contextId,
          layer: MemoryLayer.LONG_TERM,
          maxResults: 1,
        });
        return searchResults[0]?.item;
    }
    
    return undefined;
  }

  /**
   * 搜索长期知识库
   */
  public async searchLongTermKnowledge(query: SearchQuery): Promise<SearchResult[]> {
    try {
      return await this.longTermMemory.search(query);
    } catch (error) {
      this.error(`搜索长期知识失败`, error as Error);
      throw error;
    }
  }

  /**
   * 执行数据迁移
   */
  public async migrateData(): Promise<{
    shortToMedium: number;
    mediumToLong: number;
  }> {
    const migrationResult = {
      shortToMedium: 0,
      mediumToLong: 0,
    };

    try {
      // 短期 -> 中期迁移
      migrationResult.shortToMedium = await this.migrateShortToMediumTerm();

      // 中期 -> 长期迁移
      migrationResult.mediumToLong = await this.migrateMediumToLongTerm();

      this.emit('migrationCompleted', migrationResult);
      return migrationResult;
    } catch (error) {
      this.error('数据迁移失败', error as Error);
      throw error;
    }
  }

  /**
   * 短期到中期迁移
   */
  private async migrateShortToMediumTerm(): Promise<number> {
    const shortTermContexts = await this.shortTermMemory.getAll();
    let migratedCount = 0;

    for (const context of shortTermContexts) {
      if (this.migrationStrategy.shortToMedium.condition(context)) {
        const transformedData = this.migrationStrategy.shortToMedium.transform(context);
        await this.storeContext(transformedData, MemoryLayer.MEDIUM_TERM);
        
        // 从短期内存中删除
        await this.shortTermMemory.remove(context.id);
        migratedCount++;
      }
    }

    this.log(`短期->中期迁移完成: ${migratedCount} 个上下文`);
    return migratedCount;
  }

  /**
   * 中期到长期迁移
   */
  private async migrateMediumToLongTerm(): Promise<number> {
    const mediumTermSessions = Array.from((this.mediumTermMemory as any).sessions.values());
    let migratedCount = 0;

    for (const context of mediumTermSessions) {
      if (this.migrationStrategy.mediumToLong.condition(context)) {
        // 生成摘要
        const summary = this.migrationStrategy.mediumToLong.summary(context);
        
        // 提取知识
        const knowledgeItems = this.migrationStrategy.mediumToLong.extract(context);
        
        // 存储到长期内存
        for (const knowledge of knowledgeItems) {
          await this.longTermMemory.index(knowledge);
        }
        
        migratedCount += knowledgeItems.length;
      }
    }

    this.log(`中期->长期迁移完成: ${migratedCount} 个知识项`);
    return migratedCount;
  }

  /**
   * 获取内存使用统计
   */
  public async getMemoryStats(): Promise<{
    shortTerm: { count: number; totalSize: number };
    mediumTerm: { count: number; totalSize: number };
    longTerm: { count: number; totalSize: number; knowledgeTypes: Record<string, number> };
    totalMemory: number;
  }> {
    const shortTermData = await this.shortTermMemory.getAll();
    const mediumTermCount = this.mediumTermMemory.size;
    // TODO: 获取中期内存大小统计

    const longTermKnowledge = await this.longTermMemory.search({ // 获取所有长期知识
      query: '',
      layer: MemoryLayer.LONG_TERM,
      maxResults: 1000000,
    });

    const knowledgeTypes: Record<string, number> = {};
    longTermKnowledge.forEach(result => {
      const knowledge = result.item.data as PersistentKnowledge;
      knowledgeTypes[knowledge.type] = (knowledgeTypes[knowledge.type] || 0) + 1;
    });

    const stats = {
      shortTerm: {
        count: shortTermData.length,
        totalSize: shortTermData.reduce((sum, item) => sum + item.size, 0),
      },
      mediumTerm: {
        count: mediumTermCount,
        totalSize: mediumTermCount * 1024, // 估算
      },
      longTerm: {
        count: longTermKnowledge.length,
        totalSize: longTermKnowledge.reduce((sum, result) => sum + result.item.size, 0),
        knowledgeTypes,
      },
      totalMemory: 0,
    };

    stats.totalMemory = stats.shortTerm.totalSize + stats.mediumTerm.totalSize + stats.longTerm.totalSize;

    return stats;
  }

  /**
   * 清理过期数据
   */
  public async cleanup(): Promise<{
    shortTerm: number;
    mediumTerm: number;
    longTerm: number;
  }> {
    const cleanupResult = {
      shortTerm: 0,
      mediumTerm: 0,
      longTerm: 0,
    };

    try {
      // 清理短期内存（通过LRU机制自动处理）
      const shortTermData = await this.shortTermMemory.getAll();
      cleanupResult.shortTerm = shortTermData.length;

      // 清理中期内存（检查过期时间）
      const mediumTermSessions = Array.from((this.mediumTermMemory as any).sessions.values());
      const now = Date.now();
      for (const session of mediumTermSessions) {
        if (now - session.timestamp > this.config.mediumTerm.maxDuration) {
          await (this.mediumTermMemory as any).sessions.delete(session.id);
          cleanupResult.mediumTerm++;
        }
      }

      // 清理长期内存（基于低相关性和低使用频率）
      const searchResults = await this.searchLongTermKnowledge({
        query: '',
        minRelevance: 0.1,
        maxResults: 1000,
      });

      for (const result of searchResults) {
        if (result.score < 0.1 && result.item.accessCount < 5) {
          this.longTermMemory['knowledge'].delete(result.item.id);
          cleanupResult.longTerm++;
        }
      }

      this.emit('cleanupCompleted', cleanupResult);
      return cleanupResult;
    } catch (error) {
      this.error('清理失败', error as Error);
      throw error;
    }
  }

  /**
   * 初始化迁移策略
   */
  private initializeMigrationStrategy(): MigrationStrategy {
    return {
      shortToMedium: {
        condition: (data: ContextData) => {
          // 时间：超过2小时仍被访问的上下文
          const age = Date.now() - data.timestamp;
          const isOld = age > 2 * 60 * 60 * 1000;
          const isFrequentlyAccessed = data.accessCount > 5;
          return isOld && isFrequentlyAccessed;
        },
        transform: (data: ContextData): ContextData => {
          // 将短期数据转换为中期数据格式
          return {
            ...data,
            type: MemoryLayer.MEDIUM_TERM,
            priority: data.priority + 10, // 提升优先级
          };
        },
      },
      
      mediumToLong: {
        condition: (data: ContextData) => {
          // 重要的会话，提取模式和知识
          return data.priority > 70 && data.accessCount > 10;
        },
        summary: (data: ContextData): string => {
          const sessionData = data.data as SessionContext;
          return sessionData.summary || `用户 ${sessionData.userId} 的会话摘要`;
        },
        extract: (data: ContextData): PersistentKnowledge[] => {
          // 从会话数据中提取有价值的知识
          const sessionData = data.data as SessionContext;
          
          return [
            {
              id: `user_pref_${sessionData.userId}_${Date.now()}`,
              type: 'user_preference',
              content: {
                userId: sessionData.userId,
                preferences: sessionData.preferences,
                behavior: sessionData.statistics,
              },
              relevance: 0.8,
              confidence: 0.9,
              lastUpdated: Date.now(),
              usageCount: sessionData.statistics.totalMessages,
              tags: ['user', 'preference', 'behavior'],
              connections: [],
            },
          ];
        },
      },
    };
  }

  /**
   * 启动清理调度器
   */
  private startCleanupScheduler(): void {
    // 短期内存清理
    setInterval(async () => {
      try {
        await this.shortTermMemory.cleanupExpired();
      } catch (error) {
        this.error('短期内存清理失败', error as Error);
      }
    }, this.config.shortTerm.cleanupInterval);

    // 全局清理（mapper of memory layers）
    setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        this.error('全局清理失败', error as Error);
      }
    }, this.config.mediumTerm.cleanupInterval);
  }

  /**
   * 启动迁移调度器
   */
  private startMigrationScheduler(): void {
    setInterval(async () => {
      try {
        await this.migrateData();
      } catch (error) {
        this.error('数据迁移失败', error as Error);
      }
    }, 6 * 60 * 60 * 1000); // 每6小时迁移一次
  }

  /**
   * 转换数据到目标层级
   */
  private convertToLayer(data: ContextData, targetLayer: MemoryLayer): ContextData {
    return {
      ...data,
      type: targetLayer,
      priority: targetLayer === MemoryLayer.SHORT_TERM ? 100 : 
                targetLayer === MemoryLayer.MEDIUM_TERM ? 50 : 25,
    };
  }

  /**
   * 销毁管理器
   */
  public async destroy(): Promise<void> {
    this.log('销毁分层内存管理器...');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    if (this.migrationInterval) {
      clearInterval(this.migrationInterval);
    }

    // 清理各种内存
    this.shortTermMemory.clear();
    this.mediumTermMemory.clear();
    this.longTermMemory.clear();

    this.removeAllListeners();
    this.log('分层内存管理器已销毁');
  }

  private log(message: string, data?: unknown): void {
    console.log(`[LayeredMemoryManager] ${message}`, data || '');
  }

  private error(message: string, error?: Error): void {
    console.error(`[LayeredMemoryManager] ${message}`, error || '');
  }
}