import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import type { BladeConfig } from '../config/types/index.js';

export class ChatRecordingService {
  private config: BladeConfig;
  private recordingsDir: string;
  private activeRecordings: Map<string, ChatRecording> = new Map();
  private isRecording = false;

  constructor(config: BladeConfig) {
    this.config = config;
    this.recordingsDir = this.getRecordingsDirectory();
  }

  private getRecordingsDirectory(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.blade', 'recordings');
  }

  public async initialize(): Promise<void> {
    // 确保录制目录存在
    await fs.mkdir(this.recordingsDir, { recursive: true });

    console.log('聊天记录服务初始化完成');
  }

  // 开始录制
  public async startRecording(options?: RecordingOptions): Promise<string> {
    if (this.isRecording) {
      throw new Error('录制已在进行中');
    }

    const recordingId = this.generateRecordingId();
    const startTime = Date.now();

    const recording: ChatRecording = {
      id: recordingId,
      startTime,
      messages: [],
      metadata: {
        title: options?.title || `聊天记录 ${new Date().toISOString()}`,
        description: options?.description || '',
        tags: options?.tags || [],
        model: options?.model || 'gpt-4',
        provider: options?.provider || 'openai',
        createdAt: new Date().toISOString(),
      },
      options: options || {},
    };

    this.activeRecordings.set(recordingId, recording);
    this.isRecording = true;

    console.log(`开始录制聊天: ${recordingId}`);
    return recordingId;
  }

  // 停止录制
  public async stopRecording(recordingId: string): Promise<ChatRecording> {
    const recording = this.activeRecordings.get(recordingId);

    if (!recording) {
      throw new Error(`录制未找到: ${recordingId}`);
    }

    if (!this.isRecording) {
      throw new Error('没有正在进行的录制');
    }

    recording.endTime = Date.now();
    recording.duration = recording.endTime - recording.startTime;

    // 保存录制
    await this.saveRecording(recording);

    // 从活动录制中移除
    this.activeRecordings.delete(recordingId);
    this.isRecording = false;

    console.log(`停止录制聊天: ${recordingId}`);
    return recording;
  }

  // 添加消息到录制
  public async addMessageToRecording(
    recordingId: string,
    message: ChatMessage
  ): Promise<void> {
    const recording = this.activeRecordings.get(recordingId);

    if (!recording) {
      throw new Error(`录制未找到: ${recordingId}`);
    }

    if (!this.isRecording) {
      throw new Error('没有正在进行的录制');
    }

    // 添加时间戳
    const timestampedMessage: ChatMessage = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };

    recording.messages.push(timestampedMessage);

    // 如果达到自动保存阈值，保存到磁盘
    if (recording.messages.length % 10 === 0) {
      await this.saveRecording(recording);
    }
  }

  // 保存录制到文件
  private async saveRecording(recording: ChatRecording): Promise<void> {
    try {
      const filename = `${recording.id}.json`;
      const filePath = path.join(this.recordingsDir, filename);

      // 创建录制副本以避免修改原始数据
      const recordingCopy = {
        ...recording,
        savedAt: Date.now(),
      };

      const content = JSON.stringify(recordingCopy, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');

      console.log(`录制已保存: ${filePath}`);
    } catch (error) {
      console.error(`保存录制失败: ${recording.id}`, error);
      throw error;
    }
  }

  // 加载录制
  public async loadRecording(recordingId: string): Promise<ChatRecording> {
    try {
      const filename = `${recordingId}.json`;
      const filePath = path.join(this.recordingsDir, filename);

      const content = await fs.readFile(filePath, 'utf-8');
      const recording = JSON.parse(content) as ChatRecording;

      return recording;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`录制未找到: ${recordingId}`);
      }

      console.error(`加载录制失败: ${recordingId}`, error);
      throw error;
    }
  }

  // 列出所有录制
  public async listRecordings(
    options?: ListRecordingsOptions
  ): Promise<ChatRecordingInfo[]> {
    try {
      const files = await fs.readdir(this.recordingsDir);
      const recordingFiles = files.filter((file) => file.endsWith('.json'));

      const recordings: ChatRecordingInfo[] = [];

      for (const file of recordingFiles) {
        try {
          const filePath = path.join(this.recordingsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const recording = JSON.parse(content) as ChatRecording;

          const info: ChatRecordingInfo = {
            id: recording.id,
            title: recording.metadata.title,
            description: recording.metadata.description,
            createdAt: recording.metadata.createdAt,
            startTime: recording.startTime,
            endTime: recording.endTime,
            duration: recording.duration,
            messageCount: recording.messages.length,
            tags: recording.metadata.tags,
            model: recording.metadata.model,
            provider: recording.metadata.provider,
          };

          // 应用过滤器
          if (this.matchesFilter(info, options)) {
            recordings.push(info);
          }
        } catch (error) {
          console.warn(`无法读取录制文件: ${file}`, error);
        }
      }

      // 排序
      recordings.sort((a, b) => {
        const order = options?.order || 'desc';
        const sortBy = options?.sortBy || 'createdAt';

        if (order === 'asc') {
          return (a as any)[sortBy] > (b as any)[sortBy] ? 1 : -1;
        } else {
          return (a as any)[sortBy] < (b as any)[sortBy] ? 1 : -1;
        }
      });

      // 限制数量
      if (options?.limit) {
        return recordings.slice(0, options.limit);
      }

      return recordings;
    } catch (error) {
      console.error('列出录制失败', error);
      throw error;
    }
  }

  private matchesFilter(
    info: ChatRecordingInfo,
    options?: ListRecordingsOptions
  ): boolean {
    if (!options) return true;

    // 按标签过滤
    if (options.tags && options.tags.length > 0) {
      const hasTag = options.tags.some((tag) => info.tags.includes(tag));
      if (!hasTag) return false;
    }

    // 按模型过滤
    if (options.model && info.model !== options.model) {
      return false;
    }

    // 按提供者过滤
    if (options.provider && info.provider !== options.provider) {
      return false;
    }

    // 按日期范围过滤
    if (options.dateFrom) {
      const createdAt = new Date(info.createdAt).getTime();
      if (createdAt < new Date(options.dateFrom).getTime()) {
        return false;
      }
    }

    if (options.dateTo) {
      const createdAt = new Date(info.createdAt).getTime();
      if (createdAt > new Date(options.dateTo).getTime()) {
        return false;
      }
    }

    return true;
  }

  // 删除录制
  public async deleteRecording(recordingId: string): Promise<void> {
    try {
      // 从活动录制中移除
      this.activeRecordings.delete(recordingId);

      // 删除文件
      const filename = `${recordingId}.json`;
      const filePath = path.join(this.recordingsDir, filename);
      await fs.unlink(filePath);

      console.log(`录制已删除: ${recordingId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`录制未找到: ${recordingId}`);
      }

      console.error(`删除录制失败: ${recordingId}`, error);
      throw error;
    }
  }

  // 导出录制
  public async exportRecording(
    recordingId: string,
    format: ExportFormat = 'json'
  ): Promise<string> {
    const recording = await this.loadRecording(recordingId);

    switch (format) {
      case 'json':
        return JSON.stringify(recording, null, 2);

      case 'markdown':
        return this.convertToMarkdown(recording);

      case 'csv':
        return this.convertToCsv(recording);

      default:
        throw new Error(`不支持的导出格式: ${format}`);
    }
  }

  private convertToMarkdown(recording: ChatRecording): string {
    let markdown = `# ${recording.metadata.title}\n\n`;

    if (recording.metadata.description) {
      markdown += `${recording.metadata.description}\n\n`;
    }

    markdown += `**创建时间**: ${recording.metadata.createdAt}\n`;
    markdown += `**模型**: ${recording.metadata.model}\n`;
    markdown += `**提供者**: ${recording.metadata.provider}\n`;
    markdown += `**消息数量**: ${recording.messages.length}\n\n`;

    if (recording.metadata.tags.length > 0) {
      markdown += `**标签**: ${recording.metadata.tags.join(', ')}\n\n`;
    }

    markdown += '## 对话记录\n\n';

    for (const message of recording.messages) {
      const timestamp = new Date(message.timestamp!).toISOString();
      markdown += `### ${message.role} (${timestamp})\n\n`;
      markdown += `${message.content}\n\n`;
    }

    return markdown;
  }

  private convertToCsv(recording: ChatRecording): string {
    let csv = 'role,content,timestamp\n';

    for (const message of recording.messages) {
      const timestamp = new Date(message.timestamp!).toISOString();
      const content = `"${message.content.replace(/"/g, '""')}"`;
      csv += `${message.role},${content},${timestamp}\n`;
    }

    return csv;
  }

  // 导入录制
  public async importRecording(
    data: string,
    format: ImportFormat = 'json'
  ): Promise<string> {
    let recording: ChatRecording;

    switch (format) {
      case 'json':
        recording = JSON.parse(data) as ChatRecording;
        break;

      default:
        throw new Error(`不支持的导入格式: ${format}`);
    }

    // 验证录制数据
    if (!recording.id || !recording.messages) {
      throw new Error('无效的录制数据');
    }

    // 保存录制
    await this.saveRecording(recording);

    return recording.id;
  }

  // 获取录制统计
  public async getRecordingStats(): Promise<RecordingStats> {
    const recordings = await this.listRecordings();

    let totalMessages = 0;
    let totalDuration = 0;
    const modelStats: Record<string, number> = {};
    const providerStats: Record<string, number> = {};

    for (const recording of recordings) {
      totalMessages += recording.messageCount;
      totalDuration += recording.duration || 0;

      modelStats[recording.model] = (modelStats[recording.model] || 0) + 1;
      providerStats[recording.provider] = (providerStats[recording.provider] || 0) + 1;
    }

    return {
      totalRecordings: recordings.length,
      totalMessages,
      totalDuration,
      averageMessagesPerRecording:
        recordings.length > 0 ? totalMessages / recordings.length : 0,
      averageDurationPerRecording:
        recordings.length > 0 ? totalDuration / recordings.length : 0,
      modelDistribution: modelStats,
      providerDistribution: providerStats,
    };
  }

  // 搜索录制内容
  public async searchRecordings(
    query: string,
    _options?: SearchOptions
  ): Promise<ChatRecordingInfo[]> {
    const allRecordings = await this.listRecordings();
    const matchingRecordings: ChatRecordingInfo[] = [];

    for (const recordingInfo of allRecordings) {
      try {
        const recording = await this.loadRecording(recordingInfo.id);

        // 搜索标题和描述
        if (
          recording.metadata.title.toLowerCase().includes(query.toLowerCase()) ||
          recording.metadata.description.toLowerCase().includes(query.toLowerCase())
        ) {
          matchingRecordings.push(recordingInfo);
          continue;
        }

        // 搜索消息内容
        const hasMatchingMessage = recording.messages.some((message) =>
          message.content.toLowerCase().includes(query.toLowerCase())
        );

        if (hasMatchingMessage) {
          matchingRecordings.push(recordingInfo);
        }
      } catch (error) {
        console.warn(`搜索录制时无法加载: ${recordingInfo.id}`, error);
      }
    }

    return matchingRecordings;
  }

  // 获取活动录制
  public getActiveRecording(): ChatRecording | null {
    const recordingIds = Array.from(this.activeRecordings.keys());
    if (recordingIds.length === 0) {
      return null;
    }

    return this.activeRecordings.get(recordingIds[0]) || null;
  }

  // 检查是否正在录制
  public isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  // 生成录制ID
  private generateRecordingId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `rec_${timestamp}_${random}`;
  }

  // 清理旧录制
  public async cleanupOldRecordings(olderThanDays: number = 30): Promise<void> {
    try {
      const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const recordings = await this.listRecordings();

      for (const recording of recordings) {
        const createdAt = new Date(recording.createdAt).getTime();

        if (createdAt < cutoffTime) {
          try {
            await this.deleteRecording(recording.id);
            console.log(`已清理旧录制: ${recording.id}`);
          } catch (error) {
            console.warn(`清理录制失败: ${recording.id}`, error);
          }
        }
      }
    } catch (error) {
      console.error('清理旧录制失败', error);
    }
  }

  // 备份录制
  public async backupRecordings(backupDir: string): Promise<void> {
    try {
      await fs.mkdir(backupDir, { recursive: true });

      const files = await fs.readdir(this.recordingsDir);

      for (const file of files) {
        const srcPath = path.join(this.recordingsDir, file);
        const destPath = path.join(backupDir, file);
        await fs.copyFile(srcPath, destPath);
      }

      console.log(`录制已备份到: ${backupDir}`);
    } catch (error) {
      console.error('备份录制失败', error);
      throw error;
    }
  }

  // 恢复录制
  public async restoreRecordings(backupDir: string): Promise<void> {
    try {
      const files = await fs.readdir(backupDir);
      const recordingFiles = files.filter((file) => file.endsWith('.json'));

      for (const file of recordingFiles) {
        const srcPath = path.join(backupDir, file);
        const destPath = path.join(this.recordingsDir, file);
        await fs.copyFile(srcPath, destPath);
      }

      console.log(`录制已从备份恢复: ${backupDir}`);
    } catch (error) {
      console.error('恢复录制失败', error);
      throw error;
    }
  }

  public async destroy(): Promise<void> {
    // 停止所有活动录制
    for (const recordingId of this.activeRecordings.keys()) {
      try {
        await this.stopRecording(recordingId);
      } catch (error) {
        console.warn(`停止录制失败: ${recordingId}`, error);
      }
    }

    this.activeRecordings.clear();
    this.isRecording = false;

    console.log('聊天记录服务已销毁');
  }
}

// 类型定义
interface RecordingOptions {
  title?: string;
  description?: string;
  tags?: string[];
  model?: string;
  provider?: string;
  autoSaveInterval?: number;
}

export interface ChatRecording {
  id: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  messages: ChatMessage[];
  metadata: {
    title: string;
    description: string;
    tags: string[];
    model: string;
    provider: string;
    createdAt: string;
  };
  options: RecordingOptions;
  savedAt?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface ChatRecordingInfo {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  messageCount: number;
  tags: string[];
  model: string;
  provider: string;
}

interface ListRecordingsOptions {
  limit?: number;
  sortBy?: 'createdAt' | 'startTime' | 'messageCount' | 'duration';
  order?: 'asc' | 'desc';
  tags?: string[];
  model?: string;
  provider?: string;
  dateFrom?: string;
  dateTo?: string;
}

type ExportFormat = 'json' | 'markdown' | 'csv';

type ImportFormat = 'json';

interface RecordingStats {
  totalRecordings: number;
  totalMessages: number;
  totalDuration: number;
  averageMessagesPerRecording: number;
  averageDurationPerRecording: number;
  modelDistribution: Record<string, number>;
  providerDistribution: Record<string, number>;
}

interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}
