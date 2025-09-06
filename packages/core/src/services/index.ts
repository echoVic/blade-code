// 核心服务导出

export { ChatRecordingService } from './chatRecordingService.js';
export { ChatService } from './ChatService.js';
export { FileSystemService } from './fileSystemService.js';
export { GitService } from './gitService.js';

// 类型定义
export type {
  FileInfo,
  ReadFileOptions,
  SearchOptions,
  SearchResult,
  WriteFileOptions,
} from './fileSystemService.js';

export type { GitBranchInfo, GitCommit, GitResult, GitStatus } from './gitService.js';

export type { ChatMessage, ChatRecording, ChatRecordingInfo } from './chatRecordingService.js';

export type { ChatConfig, ChatResponse, ChatMessage as ChatServiceMessage } from './ChatService.js';
