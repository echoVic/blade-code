import { execSync, spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import picomatch from 'picomatch';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { getCwd } from '../../../utils/cwd.js';
import { DEFAULT_EXCLUDE_DIRS } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, GrepMetadata, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { getRipgrep, type RipgrepCommand } from './ripgrep.js';

/** 搜索策略枚举 */
enum SearchStrategy {
  RIPGREP = 'ripgrep',
  GIT_GREP = 'git-grep',
  SYSTEM_GREP = 'system-grep',
  FALLBACK = 'fallback',
}

const VCS_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

/** 搜索结果条目 */
interface GrepMatch {
  file_path: string;
  line_number?: number;
  content?: string;
  context_before?: string[];
  context_after?: string[];
  count?: number;
}

/** 检查是否在 git 仓库中 */
async function isGitRepository(path: string): Promise<boolean> {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: path,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** 检查系统 grep 是否可用 */
function isSystemGrepAvailable(): boolean {
  try {
    execSync('grep --version', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** 执行 ripgrep 搜索 */
async function executeRipgrep(
  rg: RipgrepCommand,
  args: string[],
  outputMode: string,
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(rg.command, [...rg.args, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    child.on('error', (error) => {
      reject(error);
    });

    // 处理中止信号
    const abortHandler = () => {
      child.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    child.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/** 执行 git grep 搜索（降级策略 1） */
async function executeGitGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    glob?: string;
    contextLines?: number;
  },
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['grep', '-n']; // -n 显示行号

  if (options.caseInsensitive) {
    args.push('-i');
  }

  if (options.contextLines !== undefined) {
    args.push(`-C${options.contextLines}`);
  }

  args.push('-e', pattern);

  // git grep 不直接支持 glob，但可以使用 -- 限制路径
  if (options.glob) {
    args.push('--', options.glob);
  }

  return new Promise((resolve, reject) => {
    const process = spawn('git', args, {
      cwd: path,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    process.on('error', (error) => {
      reject(error);
    });

    const abortHandler = () => {
      process.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    process.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/** 执行系统 grep 搜索（降级策略 2） */
async function executeSystemGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    contextLines?: number;
  },
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['-rn']; // -r 递归, -n 显示行号

  if (options.caseInsensitive) {
    args.push('-i');
  }

  if (options.contextLines !== undefined) {
    args.push(`-C${options.contextLines}`);
  }

  // 排除常见目录
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push('--exclude-dir=' + dir.replace(/^\./, ''));
  }

  args.push('-e', pattern, path);

  return new Promise((resolve, reject) => {
    const process = spawn('grep', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    process.on('error', (error) => {
      reject(error);
    });

    const abortHandler = () => {
      process.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    process.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/** 纯 JavaScript 实现的搜索（最终降级方案） */
async function executeFallbackGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    glob?: string;
    multiline?: boolean;
  },
  signal: AbortSignal
): Promise<{ matches: GrepMatch[]; totalFiles: number }> {
  const matches: GrepMatch[] = [];
  const regex = new RegExp(pattern, options.caseInsensitive ? 'gi' : 'g');

  // 获取所有文件
  const files = await getAllFiles(path, signal);
  let processedFiles = 0;

  for (const file of files) {
    signal.throwIfAborted();

    // 检查是否应该排除此文件
    if (shouldExcludeFile(file)) {
      continue;
    }

    // 如果指定了 glob，检查是否匹配
    if (options.glob && !matchGlob(file, options.glob)) {
      continue;
    }

    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({
            file_path: relative(path, file),
            line_number: index + 1,
            content: line,
          });
        }
      });

      processedFiles++;
    } catch (_error) {
      // 忽略无法读取的文件
      continue;
    }
  }

  return { matches, totalFiles: processedFiles };
}

/** 递归获取所有文件 */
async function getAllFiles(dir: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string) {
    signal.throwIfAborted();

    try {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        signal.throwIfAborted();

        const fullPath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // 检查是否应该排除此目录
          if (!shouldExcludeFile(fullPath)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (_error) {
      // 忽略无法访问的目录
    }
  }

  await walk(dir);
  return files;
}

/** 检查文件/目录是否应该被排除 */
function shouldExcludeFile(path: string): boolean {
  for (const pattern of DEFAULT_EXCLUDE_DIRS) {
    if (path.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/** 使用 picomatch 进行 glob 匹配 */
function matchGlob(filePath: string, pattern: string): boolean {
  const isMatch = picomatch(pattern);
  return isMatch(filePath);
}

/** 构建 ripgrep 命令参数 */
function buildRipgrepArgs(options: {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  output_mode: string;
  case_insensitive: boolean;
  context_before?: number;
  context_after?: number;
  context?: number;
  head_limit?: number;
  offset?: number;
  multiline: boolean;
  bundled: boolean;
}): string[] {
  const args: string[] = ['--hidden'];

  // 内置 rg 编译了 PCRE2：前后断言、反向引用等自动切换引擎
  if (options.bundled) {
    args.push('--engine', 'auto');
  }

  if (options.case_insensitive) {
    args.push('-i');
  }

  if (options.multiline) {
    args.push('-U', '--multiline-dotall');
  }

  // 输出模式：content 用 JSON 事件，其余用 NUL 分隔，路径不再有歧义；
  // 搜索单个文件时 rg 默认不输出文件名，count 需显式要求
  switch (options.output_mode) {
    case 'files_with_matches':
      args.push('-l', '--null');
      break;
    case 'count':
      args.push('-c', '--with-filename', '--null');
      break;
    case 'content':
      args.push('--json');
      break;
  }

  // 上下文行
  if (options.context !== undefined && options.output_mode === 'content') {
    args.push('-C', options.context.toString());
  } else {
    if (options.context_before !== undefined && options.output_mode === 'content') {
      args.push('-B', options.context_before.toString());
    }
    if (options.context_after !== undefined && options.output_mode === 'content') {
      args.push('-A', options.context_after.toString());
    }
  }

  // 文件类型过滤
  if (options.type) {
    args.push('--type', options.type);
  }

  // --hidden 会进入点目录，版本库目录需要显式排除
  for (const dir of VCS_DIRECTORIES) {
    args.push('--glob', `!${dir}`);
  }

  // 默认排除常见目录
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push('--glob', `!${dir}/**`);
  }

  // 用户自定义 Glob 模式
  if (options.glob) {
    args.push('--glob', options.glob);
  }

  // 结果限制
  if (options.head_limit !== undefined) {
    const totalLimit = (options.offset ?? 0) + options.head_limit;
    args.push('-m', totalLimit.toString());
  }

  // 搜索模式；以 - 开头的模式不能被当成参数
  args.push('-e', options.pattern);

  // 搜索路径
  args.push(options.path);

  return args;
}

/** 解析 git grep/system grep 的文本输出（rg 的输出见 parseRipgrepOutput） */
export function parseGrepOutput(
  output: string,
  outputMode: string,
  contextAfter = 0
): GrepMatch[] {
  if (!output.trim()) {
    return [];
  }

  const lines = output.trim().split('\n');

  switch (outputMode) {
    case 'files_with_matches':
      return lines.map((line) => ({
        file_path: line.trim(),
      }));

    case 'count':
      return lines.map((line) => {
        // 计数在最后一个冒号之后，路径本身可能含冒号（如 Windows 盘符）
        const separatorIndex = line.lastIndexOf(':');
        return {
          file_path: line.substring(0, separatorIndex),
          count: parseInt(line.substring(separatorIndex + 1), 10),
        };
      });

    case 'content':
      return parseContentOutput(lines, contextAfter);

    default:
      return [];
  }
}

/** 以 `--` 分隔的每组输出来自同一文件：匹配行为 path:N:text，上下文行为 path-N-text */
function parseContentOutput(lines: string[], contextAfter: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  let group: string[] = [];
  const flush = () => {
    if (group.length > 0) {
      matches.push(...parseContentGroup(group, contextAfter));
      group = [];
    }
  };

  for (const line of lines) {
    if (line === '--') {
      flush();
    } else if (line) {
      group.push(line);
    }
  }
  flush();
  return matches;
}

/** 上下文行挂到相邻匹配：两次匹配之间的行先补足前一条的 after，其余归后一条的 before */
function parseContentGroup(lines: string[], contextAfter: number): GrepMatch[] {
  const group = splitContentGroup(lines);
  if (!group) {
    return lines.map(parseContentLine).filter((match) => match !== null);
  }

  const matches: GrepMatch[] = [];
  let pending: string[] = [];
  for (const entry of group.entries) {
    if (!entry.isMatch) {
      pending.push(entry.text);
      continue;
    }
    const previous = matches.at(-1);
    if (previous) {
      const after = pending.splice(0, contextAfter);
      if (after.length > 0) previous.context_after = after;
    }
    const match: GrepMatch = {
      file_path: group.filePath,
      line_number: entry.lineNumber,
      content: entry.text,
    };
    if (pending.length > 0) match.context_before = pending;
    matches.push(match);
    pending = [];
  }

  const last = matches.at(-1);
  if (last && pending.length > 0) last.context_after = pending;
  return matches;
}

interface ContentEntry {
  lineNumber: number;
  isMatch: boolean;
  text: string;
}

const LINE_NUMBER_FIELD = /([:-])(\d+)\1/y;

/** 路径可能含 `:` 或 `-数字-`，取能让组内各行解析出连续行号且含匹配行的最短前缀 */
function splitContentGroup(
  lines: string[]
): { filePath: string; entries: ContentEntry[] } | null {
  const [first] = lines;
  for (let end = 1; end < first.length; end++) {
    LINE_NUMBER_FIELD.lastIndex = end;
    if (!LINE_NUMBER_FIELD.test(first)) continue;
    const filePath = first.substring(0, end);
    const entries: ContentEntry[] = [];
    for (const line of lines) {
      LINE_NUMBER_FIELD.lastIndex = end;
      const field = line.startsWith(filePath) ? LINE_NUMBER_FIELD.exec(line) : null;
      const lineNumber = Number(field?.[2]);
      const previous = entries.at(-1);
      if (!field || (previous && lineNumber !== previous.lineNumber + 1)) break;
      entries.push({
        lineNumber,
        isMatch: field[1] === ':',
        text: line.substring(end + field[0].length),
      });
    }
    if (entries.length === lines.length && entries.some((entry) => entry.isMatch)) {
      return { filePath, entries };
    }
  }
  return null;
}

/** 解析内容行 */
function parseContentLine(line: string): GrepMatch | null {
  // 匹配格式: filename:line_number:content 或 filename:content
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;

  const filePath = line.substring(0, colonIndex);
  const remainder = line.substring(colonIndex + 1);

  // 检查是否有行号
  const secondColonIndex = remainder.indexOf(':');
  if (
    secondColonIndex !== -1 &&
    /^\d+$/.test(remainder.substring(0, secondColonIndex))
  ) {
    // 有行号的格式
    const lineNumber = parseInt(remainder.substring(0, secondColonIndex), 10);
    const content = remainder.substring(secondColonIndex + 1);

    return {
      file_path: filePath,
      line_number: lineNumber,
      content: content,
    };
  } else {
    // 无行号的格式
    return {
      file_path: filePath,
      content: remainder,
    };
  }
}

const MAX_LINE_LENGTH = 500;

interface RipgrepJsonText {
  text?: string;
  bytes?: string;
}

interface RipgrepJsonEvent {
  type: string;
  data?: {
    path?: RipgrepJsonText;
    lines?: RipgrepJsonText;
    line_number?: number | null;
    submatches?: Array<{ start: number }>;
  };
}

function decodeRipgrepText(value: RipgrepJsonText | undefined): string {
  return value?.text ?? Buffer.from(value?.bytes ?? '', 'base64').toString('utf8');
}

/** 超长行只保留 focus 附近的窗口，两端标注省略的字符数 */
function clipLine(line: string, focus: number): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  const start = Math.max(
    0,
    Math.min(line.length - MAX_LINE_LENGTH, focus - MAX_LINE_LENGTH / 2)
  );
  const end = start + MAX_LINE_LENGTH;
  const head = start > 0 ? `…[${start} chars omitted]…` : '';
  const tail = end < line.length ? `…[${line.length - end} chars omitted]…` : '';
  return `${head}${line.slice(start, end)}${tail}`;
}

/** 多行匹配逐行裁剪，首个子匹配所在的行以子匹配为中心 */
function clipMatchText(text: string, focus: number): string {
  let offset = 0;
  return text
    .split('\n')
    .map((line) => {
      const lineFocus = focus - offset;
      offset += line.length + 1;
      return clipLine(line, lineFocus >= 0 && lineFocus < line.length ? lineFocus : 0);
    })
    .join('\n');
}

/** rg 输出：content 为 --json 事件流，files_with_matches 与 count 为 NUL 分隔 */
export function parseRipgrepOutput(
  output: string,
  outputMode: string,
  contextAfter = 0
): GrepMatch[] {
  switch (outputMode) {
    case 'files_with_matches':
      return output
        .split('\0')
        .filter(Boolean)
        .map((file_path) => ({ file_path }));

    case 'count':
      return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separatorIndex = line.lastIndexOf('\0');
          return {
            file_path: line.substring(0, separatorIndex),
            count: parseInt(line.substring(separatorIndex + 1), 10),
          };
        });

    case 'content':
      return parseRipgrepJson(output, contextAfter);

    default:
      return [];
  }
}

/** 按行号挂接上下文：前一条匹配 after 范围内的行归它，其余归下一条匹配的 before */
function parseRipgrepJson(output: string, contextAfter: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  let previous: { match: GrepMatch; lastLine: number } | undefined;
  let pending: string[] = [];

  for (const line of output.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as RipgrepJsonEvent;
    const data = event.data;

    if (event.type === 'begin' || event.type === 'end') {
      previous = undefined;
      pending = [];
      continue;
    }
    if (!data || (event.type !== 'match' && event.type !== 'context')) continue;

    const raw = decodeRipgrepText(data.lines);
    const text = raw.replace(/\r?\n$/, '');
    const lineNumber = data.line_number ?? 0;

    if (event.type === 'context') {
      const clipped = clipLine(text, 0);
      if (previous && lineNumber - previous.lastLine <= contextAfter) {
        previous.match.context_after ??= [];
        previous.match.context_after.push(clipped);
      } else {
        pending.push(clipped);
      }
      continue;
    }

    // submatch 偏移按字节计，换算为字符位置
    const byteStart = data.submatches?.[0]?.start ?? 0;
    const focus = Buffer.from(raw).subarray(0, byteStart).toString('utf8').length;
    const match: GrepMatch = {
      file_path: decodeRipgrepText(data.path),
      line_number: lineNumber,
      content: clipMatchText(text, focus),
    };
    if (pending.length > 0) {
      match.context_before = pending;
      pending = [];
    }
    matches.push(match);
    previous = { match, lastLine: lineNumber + text.split('\n').length - 1 };
  }

  return matches;
}

/**
 * GrepTool - 内容搜索工具
 * 支持多级降级策略：ripgrep -> git grep -> system grep -> JavaScript fallback
 */
export const grepTool = createTool({
  name: 'Grep',
  displayName: '内容搜索',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true, // 纯读操作，无副作用
  isRetrySafe: true,

  schema: Type.Object({
    pattern: ToolSchemas.pattern({
      description: 'The regular expression pattern to search for in file contents',
    }),
    path: Type.Optional(
      Type.String({
        description:
          'File or directory to search in (rg PATH). Defaults to current working directory',
      })
    ),
    glob: Type.Optional(
      Type.String({
        description:
          'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
      })
    ),
    type: Type.Optional(
      Type.String({
        description:
          'File type to search (rg --type). Common types: js, py, rust, go, java, etc.',
      })
    ),
    output_mode: Default(
      StringEnum(['content', 'files_with_matches', 'count'], {
        description:
          'Output mode: content, files_with_matches, or count. Defaults to files_with_matches.',
      }),
      'files_with_matches'
    ),
    '-i': Type.Optional(
      Type.Boolean({ description: 'Case insensitive search (rg -i)' })
    ),
    '-n': Default(
      Type.Boolean({
        description: 'Show line numbers in content output (rg -n). Defaults to true.',
      }),
      true
    ),
    '-B': Type.Optional(
      ToolSchemas.nonNegativeInt({
        description: 'Lines before each match (rg -B)',
      })
    ),
    '-A': Type.Optional(
      ToolSchemas.nonNegativeInt({
        description: 'Lines after each match (rg -A)',
      })
    ),
    '-C': Type.Optional(
      ToolSchemas.nonNegativeInt({
        description: 'Lines before and after each match (rg -C)',
      })
    ),
    head_limit: Type.Optional(
      ToolSchemas.positiveInt({
        description: 'Limit output to first N lines or entries',
      })
    ),
    offset: Type.Optional(
      ToolSchemas.nonNegativeInt({
        description: 'Skip first N lines or entries before applying head_limit',
      })
    ),
    multiline: Default(
      Type.Boolean({
        description: 'Enable multiline matching (rg -U --multiline-dotall)',
      }),
      false
    ),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'A powerful search tool built on ripgrep',
    long: `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Task tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`,
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      pattern,
      path: requestedPath,
      glob,
      type,
      output_mode,
      '-i': caseInsensitive,
      '-n': lineNumbers = true,
      '-B': contextBefore,
      '-A': contextAfter,
      '-C': contextLines,
      head_limit,
      offset,
      multiline,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;
    const path = requestedPath ?? context.workspaceRoot ?? getCwd();

    try {
      updateOutput?.(`使用智能搜索策略查找模式 "${pattern}"...`);

      let result: { stdout: string; stderr: string; exitCode: number } | null = null;
      let strategy: SearchStrategy = SearchStrategy.RIPGREP;
      let matches: GrepMatch[] = [];

      // 策略 1: 尝试使用 ripgrep
      const rg = getRipgrep();
      if (rg) {
        try {
          updateOutput?.(`使用 ripgrep (${rg.command})`);

          const args = buildRipgrepArgs({
            pattern,
            path,
            glob,
            type,
            output_mode,
            case_insensitive: caseInsensitive ?? false,
            context_before: contextBefore,
            context_after: contextAfter,
            context: contextLines,
            head_limit,
            offset,
            multiline: multiline ?? false,
            bundled: rg.bundled,
          });

          result = await executeRipgrep(rg, args, output_mode, signal, updateOutput);
          strategy = SearchStrategy.RIPGREP;
        } catch {
          updateOutput?.(`[WARN] ripgrep 失败，尝试降级策略...`);
          result = null;
        }
      }

      // 策略 2: 降级到 git grep (如果在 git 仓库中)
      if (!result && (await isGitRepository(path))) {
        try {
          updateOutput?.(`使用 git grep`);

          result = await executeGitGrep(
            pattern,
            path,
            {
              caseInsensitive: caseInsensitive ?? false,
              glob,
              contextLines,
            },
            signal
          );
          strategy = SearchStrategy.GIT_GREP;
        } catch {
          updateOutput?.(`[WARN] git grep 失败，继续尝试其他策略...`);
          result = null;
        }
      }

      // 策略 3: 降级到系统 grep
      if (!result && isSystemGrepAvailable()) {
        try {
          updateOutput?.(`使用系统 grep`);

          result = await executeSystemGrep(
            pattern,
            path,
            {
              caseInsensitive: caseInsensitive ?? false,
              contextLines,
            },
            signal
          );
          strategy = SearchStrategy.SYSTEM_GREP;
        } catch {
          updateOutput?.(`[WARN] 系统 grep 失败，使用纯 JavaScript 实现...`);
          result = null;
        }
      }

      // 策略 4: 最终降级到纯 JavaScript 实现
      if (!result) {
        updateOutput?.(`使用纯 JavaScript 搜索实现`);

        const fallbackResult = await executeFallbackGrep(
          pattern,
          path,
          {
            caseInsensitive: caseInsensitive ?? false,
            glob,
            multiline: multiline ?? false,
          },
          signal
        );

        matches = fallbackResult.matches;
        strategy = SearchStrategy.FALLBACK;

        // 为了统一处理，创建一个假的 result 对象
        result = {
          stdout: '', // 不使用
          stderr: '',
          exitCode: 0,
        };
      } else {
        // 解析 grep 输出
        const contextAfterLines = contextLines ?? contextAfter ?? 0;
        matches =
          strategy === SearchStrategy.RIPGREP
            ? parseRipgrepOutput(result.stdout, output_mode, contextAfterLines)
            : parseGrepOutput(result.stdout, output_mode, contextAfterLines);
      }

      if (output_mode === 'content' && !lineNumbers) {
        matches = matches.map(({ line_number: _lineNumber, ...match }) => match);
      }

      // 应用 offset 裁剪（如果指定）
      const originalTotal = matches.length;
      if (offset !== undefined && offset > 0) {
        matches = matches.slice(offset);
      }

      // 应用 head_limit 裁剪（如果指定）
      if (head_limit !== undefined && matches.length > head_limit) {
        matches = matches.slice(0, head_limit);
      }

      const metadata: GrepMetadata = {
        search_pattern: pattern,
        search_path: path,
        output_mode,
        case_insensitive: caseInsensitive ?? false,
        total_matches: matches.length,
        original_total: originalTotal,
        offset: offset,
        head_limit: head_limit,
        strategy,
        exit_code: result?.exitCode,
      };

      if (result && result.exitCode !== 0 && result.stderr) {
        return {
          success: false,
          llmContent: `Search execution failed: ${result.stderr}`,
          metadata: {
            ...metadata,
            summary: `搜索失败: ${result.stderr}`,
          },
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.stderr,
          },
        };
      }

      return {
        success: true,
        llmContent: matches,
        metadata: {
          ...metadata,
          summary:
            matches.length > 0
              ? `搜索 "${pattern}" 找到 ${matches.length} 个文件`
              : `搜索 "${pattern}" 未找到匹配`,
        },
      };
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Search aborted',
          metadata: {
            summary: `搜索失败: 操作被中止`,
          },
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `Search failed: ${err.message}`,
        metadata: {
          summary: `搜索失败: ${err.message}`,
        },
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: err,
        },
      };
    }
  },

  version: '3.0.0',
  category: '搜索工具',
  tags: ['search', 'grep', 'ripgrep', 'regex', 'text', 'fallback'],

  /** 提取签名内容：返回搜索模式 */
  extractSignatureContent: (params) => params.pattern,

  /** 抽象权限规则：返回通配符模式 */
  abstractPermissionRule: () => '*',
});
