import type { ConstrainedSamplingConfig } from '@earendil-works/pi-ai';
import type { JSONSchema7 } from 'json-schema';
import type {
  BrowserErrorCode,
  BrowserInteractionVisual,
  BrowserToolName,
} from '../../browser/types.js';
import type { PermissionMode } from '../../config/types.js';
import type { GoalExecutionHostFailureCategory } from '../../goals/types.js';
import type { ExecutionContext } from './ExecutionTypes.js';
export interface NodeError extends Error {
  code?: string;
}

/**
 * 工具类型枚举（简化为 3 种）
 *
 * - ReadOnly: 只读操作，无副作用（Read, FindFiles, Glob, Grep, WebFetch, WebSearch, TaskOutput, TaskCreate/TaskGet/TaskUpdate/TaskList, Plan 工具等）
 * - Write: 文件写入操作（Edit, Write, NotebookEdit）
 * - Execute: 命令执行，可能有副作用（Bash, KillShell, Task, Skill, SlashCommand）
 *
 * ToolKind 是权限分类，不代表调用可安全重试；重放能力必须通过 isRetrySafe 单独声明。
 */
export enum ToolKind {
  ReadOnly = 'readonly',
  Write = 'write',
  Execute = 'execute',
}

interface BaseMetadataFields {
  summary?: string;
  shouldExitLoop?: boolean;
  targetMode?: PermissionMode;
  modelId?: string;
  model?: string;
}

interface FileMetadataFields extends BaseMetadataFields {
  file_path: string;
  file_size?: number;
  last_modified?: string;
}

interface DiffMetadataFields extends FileMetadataFields {
  kind: 'edit';
  oldContent: string;
  newContent?: string;
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
}

interface ReadMetadataFields extends FileMetadataFields {
  file_type: string;
  encoding: string;
  acp_mode?: boolean;
  acp_fallback?: boolean;
  is_binary?: boolean;
  lines_read?: number;
  total_lines?: number;
  start_line?: number;
  end_line?: number;
}

interface WriteMetadataFields extends DiffMetadataFields {
  content_size: number;
  encoding: string;
  created_directories?: boolean;
  has_diff?: boolean;
  write_acknowledged?: boolean;
  write_verified?: boolean;
  sideEffectsUncertain?: boolean;
}

interface EditMetadataFields extends DiffMetadataFields {
  matches_found: number;
  replacements_made: number;
  replace_all: boolean;
  old_string_length: number;
  new_string_length: number;
  original_size: number;
  new_size: number;
  size_diff: number;
  diff_snippet?: string | null;
  write_acknowledged?: boolean;
  write_verified?: boolean;
  sideEffectsUncertain?: boolean;
}

export interface ApplyPatchChangeMetadata {
  kind: 'add' | 'update' | 'delete';
  path: string;
  oldContent: string | null;
  newContent: string | null;
  diff?: string;
}

interface ApplyPatchMetadataFields extends BaseMetadataFields {
  kind: 'patch';
  changes: ApplyPatchChangeMetadata[];
  affected_paths: string[];
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
  write_acknowledged?: boolean;
  write_verified?: boolean;
  sideEffectsUncertain?: boolean;
  requiresRead?: boolean;
}

interface EditErrorMetadataFields extends BaseMetadataFields {
  searchStringLength: number;
  fuzzyMatches: Array<{
    line: number;
    similarity: number;
    preview: string;
  }>;
  excerptRange: [number, number];
  totalLines: number;
}

interface GlobMetadataFields extends BaseMetadataFields {
  search_path: string;
  pattern: string;
  total_matches: number;
  returned_matches: number;
  max_results: number;
  include_directories?: boolean;
  case_sensitive?: boolean;
  truncated: boolean;
  matches?: Array<{
    path: string;
    relative_path: string;
    is_directory: boolean;
    mtime?: number;
  }>;
}

interface GrepMetadataFields extends BaseMetadataFields {
  search_pattern: string;
  search_path: string;
  output_mode: string;
  case_insensitive?: boolean;
  total_matches: number;
  original_total?: number;
  offset?: number;
  head_limit?: number;
  strategy?: string;
  exit_code?: number;
}

interface BashBackgroundMetadataFields extends BaseMetadataFields {
  command: string;
  background: true;
  pid?: number;
  bash_id: string;
  shell_id: string;
  message?: string;
  sandboxed?: boolean;
  auto_backgrounded?: boolean;
  background_reason?: 'explicit' | 'foreground_budget';
  foreground_budget_ms?: number;
  terminal_transport?: 'local' | 'acp';
  acp_mode?: boolean;
}

interface BashForegroundMetadataFields extends BaseMetadataFields {
  command: string;
  execution_host_failure?: GoalExecutionHostFailureCategory;
  background?: false;
  execution_time: number;
  exit_code: number | null;
  signal?: NodeJS.Signals | null;
  stdout_length?: number;
  stderr_length?: number;
  capture_truncated?: boolean;
  projection_truncated?: boolean;
  output_truncated?: boolean;
  stdout_total_bytes?: number;
  stderr_total_bytes?: number;
  stdout_retained_bytes?: number;
  stderr_retained_bytes?: number;
  stdout_omitted_bytes?: number;
  stderr_omitted_bytes?: number;
  raw_output_bytes?: number;
  stdout_projection_truncated?: boolean;
  stderr_projection_truncated?: boolean;
  output_accounting_complete?: boolean;
  terminal_transport?: 'local' | 'acp' | 'local_fallback';
  terminal_output_merged?: boolean;
  has_stderr?: boolean;
  acp_mode?: boolean;
  sandboxed?: boolean;
}

interface WebSearchMetadataFields extends BaseMetadataFields {
  query: string;
  provider: string;
  fetched_at: string;
  total_results: number;
  returned_results: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface WebFetchMetadataFields extends BaseMetadataFields {
  url: string;
  method: string;
  status: number;
  response_time: number;
  content_length: number;
  redirected: boolean;
  redirect_count: number;
  final_url?: string;
  content_type?: string;
  redirect_chain?: string[];
}

interface BrowserToolMetadataFields extends BaseMetadataFields {
  browser: {
    action: BrowserToolName;
    status: 'ok' | 'warning' | 'error';
    pageId?: string;
    snapshotId?: string;
    screenshotId?: string;
    origin?: string;
    url?: string;
    title?: string;
    truncated?: boolean;
    actionApplied?: boolean | 'unknown';
    sideEffectsUncertain?: boolean;
    candidateOrigin?: string;
    errorCode?: BrowserErrorCode;
    diagnosticCount?: number;
    interaction?: BrowserInteractionVisual;
    artifact?: {
      id: string;
      kind: 'image';
      mimeType: 'image/png';
      size: number;
      sha256: string;
      persisted: true;
      path?: string;
    };
  };
}

type Metadata<T extends BaseMetadataFields = BaseMetadataFields> = T & {
  [key: string]: unknown;
};
type FileMetadata = Metadata<FileMetadataFields>;
type DiffMetadata = Metadata<DiffMetadataFields>;
export type ReadMetadata = Metadata<ReadMetadataFields>;
export type WriteMetadata = Metadata<WriteMetadataFields>;
export type EditMetadata = Metadata<EditMetadataFields>;
export type ApplyPatchMetadata = Metadata<ApplyPatchMetadataFields>;
export type EditErrorMetadata = Metadata<EditErrorMetadataFields>;
export type GlobMetadata = Metadata<GlobMetadataFields>;
export type GrepMetadata = Metadata<GrepMetadataFields>;
export type BashBackgroundMetadata = Metadata<BashBackgroundMetadataFields>;
export type BashForegroundMetadata = Metadata<BashForegroundMetadataFields>;
type BashMetadata = BashBackgroundMetadata | BashForegroundMetadata;
export type WebSearchMetadata = Metadata<WebSearchMetadataFields>;
export type WebFetchMetadata = Metadata<WebFetchMetadataFields>;
export type BrowserToolMetadata = Metadata<BrowserToolMetadataFields>;
export type ToolResultMetadata = Metadata<BaseMetadataFields>;
function _isDiffMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is DiffMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.oldContent === 'string'
  );
}

function _isFileMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is FileMetadata {
  return metadata !== undefined && typeof metadata.file_path === 'string';
}

function _isBashMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is BashMetadata {
  return metadata !== undefined && typeof metadata.command === 'string';
}

export function isGlobMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GlobMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

function _isGrepMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GrepMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.search_pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

function _isReadMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is ReadMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.file_type === 'string'
  );
}

export function isEditMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is EditMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.matches_found === 'number'
  );
}

export interface ToolResultModelImage {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

// Model-only images must not enter JSON events, durable results, or UI projections.
export const TOOL_RESULT_MODEL_IMAGES = Symbol('blade.tool-result-model-images');

/** Tool result with a concrete metadata contract. */
interface TypedToolResult<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  success: boolean;
  llmContent: string | object;
  error?: ToolError;
  metadata?: TMetadata;
  [TOOL_RESULT_MODEL_IMAGES]?: ToolResultModelImage[];
}

export function attachToolResultModelImages<T extends ToolResult>(
  result: T,
  images: ToolResultModelImage[]
): T {
  Object.defineProperty(result, TOOL_RESULT_MODEL_IMAGES, {
    value: images,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function getToolResultModelImages(
  result: ToolResult
): ToolResultModelImage[] | undefined {
  return result[TOOL_RESULT_MODEL_IMAGES];
}

export function getModelVisibleToolResultContent(
  result: ToolResult,
  text: string
): string | Array<{ type: 'text'; text: string } | ToolResultModelImage> {
  const images = result.success ? getToolResultModelImages(result) : undefined;
  return images && images.length > 0 ? [{ type: 'text', text }, ...images] : text;
}

export interface ToolDisplayOutput {
  status: 'ok' | 'fail' | 'warn';
  summary: string;
  detail?: string;
}

export type ToolResult = TypedToolResult<ToolResultMetadata>;
interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: unknown;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  RESOURCE_EXHAUSTED = 'resource_exhausted',
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error',
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface ToolInvocation<TParams = unknown, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;
  /** True only when replaying after an indeterminate transient failure is safe. */
  readonly isRetrySafe?: boolean;
  getDescription(): string;
  getAffectedPaths(): string[];
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
  ): Promise<TResult>;
}

export interface ToolDescription {
  short: string;
  long?: string;
  usageNotes?: string[];
  examples?: Array<{
    description: string;
    params: Record<string, unknown>;
  }>;
  important?: string[];
}

/** 工具配置 (泛型接口，用于配合 TypeBox Schema) TSchema: TypeBox Schema 类型 TParams: 推断的参数类型 */
export interface ToolConfig<TSchema = unknown, TParams = unknown> {
  name: string;
  displayName: string;
  kind: ToolKind;
  /** 是否可与同批其他并发安全工具共享执行（可选，默认 false） */
  isConcurrencySafe?: boolean;
  /** 瞬态异常后是否可安全重放（可选，默认 false） */
  isRetrySafe?: boolean;
  /** 批内调度模式；shared 仍可由文件锁或 kind 配额进一步限流 */
  parallelism?: 'shared' | 'exclusive';
  /** 是否启用 OpenAI Structured Outputs（可选，默认 false） */
  strict?: boolean;
  /** TypeBox Schema 定义 */
  schema: TSchema;
  description: ToolDescription;
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  version?: string;
  category?: string;
  tags?: string[];

  /**
   * [OK] 新增：签名内容提取器
   * 从参数中提取用于权限签名的内容字符串
   * @param params - 类型安全的参数对象
   * @returns 签名内容字符串（如 "mv file.txt" 或 "/src/foo.ts"）
   * @example
   * // Bash 工具
   * extractSignatureContent: (params) => params.command
   * // Read 工具
   * extractSignatureContent: (params) => params.file_path
   */
  extractSignatureContent?: (params: TParams) => string;

  /** 返回调用可能读写的路径，用于权限、安全审阅和多路径工具。 */
  affectedPaths?: (params: TParams) => string[];

  /**
   * [OK] 新增：权限规则抽象器
   * 将具体参数抽象为通配符权限规则
   * @param params - 类型安全的参数对象
   * @returns 权限规则字符串（如 "mv:*" 或 "**\/*.ts"）
   * @example
   * // Bash 工具
   * abstractPermissionRule: (params) => `${extractMainCmd(params.command)}:*`
   * // Read 工具
   * abstractPermissionRule: (params) => `**\/*${path.extname(params.file_path)}`
   */
  abstractPermissionRule?: (params: TParams) => string;
}

export interface Tool<TParams = unknown> {
  readonly name: string;
  readonly displayName: string;
  readonly kind: ToolKind;
  /** 是否支持并发安全 */
  readonly isConcurrencySafe: boolean;
  /** 瞬态异常后是否可安全重放 */
  readonly isRetrySafe?: boolean;
  readonly parallelism?: 'shared' | 'exclusive';
  /** 是否启用 OpenAI Structured Outputs */
  readonly strict: boolean;
  readonly description: ToolDescription;
  readonly version: string;
  readonly category?: string;
  readonly tags: string[];
  getFunctionDeclaration(): FunctionDeclaration;
  getMetadata(): Record<string, unknown>;
  build(params: TParams): ToolInvocation<TParams>;
  execute(
    params: TParams,
    signal?: AbortSignal,
    context?: Partial<ExecutionContext>
  ): Promise<ToolResult>;

  /** [OK] 新增：签名内容提取器 从参数中提取用于权限签名的内容字符串 */
  extractSignatureContent?: (params: TParams) => string;

  /** [OK] 新增：权限规则抽象器 将具体参数抽象为通配符权限规则 */
  abstractPermissionRule?: (params: TParams) => string;
}

export function isReadOnlyKind(kind: ToolKind): boolean {
  return kind === ToolKind.ReadOnly;
}
