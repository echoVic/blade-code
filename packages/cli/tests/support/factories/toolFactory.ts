import { nanoid } from 'nanoid';

export interface ToolCallInput {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
  duration?: number;
}

export const createToolCall = (
  toolName: string,
  args: Record<string, unknown>
): { toolCallId: string; toolName: string; args: Record<string, unknown> } => ({
  toolCallId: nanoid(),
  toolName,
  args,
});

export const createToolResult = (
  toolCallId: string,
  result: unknown,
  success = true,
  error?: string
): ToolCallResult => ({
  toolCallId,
  toolName: '',
  args: {},
  result,
  success,
  error,
});

export const toolCallTemplates = {
  read: (filePath: string) => createToolCall('Read', { file_path: filePath }),

  write: (filePath: string, content: string) =>
    createToolCall('Write', { file_path: filePath, content }),

  edit: (filePath: string, oldStr: string, newStr: string) =>
    createToolCall('SearchReplace', {
      file_path: filePath,
      old_str: oldStr,
      new_str: newStr,
    }),

  glob: (pattern: string, path?: string) => createToolCall('Glob', { pattern, path }),

  grep: (pattern: string, path?: string) => createToolCall('Grep', { pattern, path }),

  runCommand: (command: string, blocking = true) =>
    createToolCall('RunCommand', { command, blocking, requires_approval: false }),

  ls: (path: string) => createToolCall('LS', { path }),

  deleteFile: (filePaths: string[]) =>
    createToolCall('DeleteFile', { file_paths: filePaths }),

  webSearch: (query: string) => createToolCall('WebSearch', { query }),

  taskCreate: (subject: string, description: string) =>
    createToolCall('TaskCreate', { subject, description }),

  taskUpdate: (taskId: string, status: string) =>
    createToolCall('TaskUpdate', { taskId, status }),

  askUserQuestion: (
    questions: Array<{ question: string; options: Array<{ label: string }> }>
  ) => createToolCall('AskUserQuestion', { questions }),
};

export const toolResultTemplates = {
  fileContent: (content: string) => ({
    success: true,
    content,
    lineCount: content.split('\n').length,
  }),

  fileWritten: (path: string) => ({
    success: true,
    message: `File written to ${path}`,
  }),

  fileEdited: (path: string, changes: number) => ({
    success: true,
    message: `File edited: ${path}`,
    changesApplied: changes,
  }),

  globResults: (files: string[]) => ({
    success: true,
    files,
    count: files.length,
  }),

  grepResults: (matches: Array<{ file: string; line: number; content: string }>) => ({
    success: true,
    matches,
    count: matches.length,
  }),

  commandOutput: (output: string, exitCode = 0) => ({
    success: exitCode === 0,
    output,
    exitCode,
  }),

  lsResults: (entries: Array<{ name: string; type: 'file' | 'directory' }>) => ({
    success: true,
    entries,
  }),

  searchResults: (results: Array<{ title: string; url: string; snippet: string }>) => ({
    success: true,
    results,
  }),

  error: (message: string, code?: string) => ({
    success: false,
    error: message,
    code,
  }),
};

export const createToolExecutionSequence = (
  calls: Array<{
    tool: ReturnType<typeof createToolCall>;
    result: unknown;
    delay?: number;
  }>
): Array<ToolCallResult> => {
  return calls.map((call) => ({
    toolCallId: call.tool.toolCallId,
    toolName: call.tool.toolName,
    args: call.tool.args,
    result: call.result,
    success: true,
    duration: call.delay || 0,
  }));
};

export const builtinToolNames = [
  'Read',
  'Write',
  'SearchReplace',
  'Glob',
  'Grep',
  'LS',
  'RunCommand',
  'CheckCommandStatus',
  'StopCommand',
  'DeleteFile',
  'WebSearch',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'AskUserQuestion',
  'Task',
  'Skill',
  'GetDiagnostics',
  'OpenPreview',
  'ExitPlanMode',
] as const;

export type BuiltinToolName = (typeof builtinToolNames)[number];
