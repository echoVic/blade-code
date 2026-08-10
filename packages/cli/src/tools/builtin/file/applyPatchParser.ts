import path from 'node:path';

const BEGIN_MARKER = '*** Begin Patch';
const END_MARKER = '*** End Patch';
const ADD_MARKER = '*** Add File: ';
const DELETE_MARKER = '*** Delete File: ';
const UPDATE_MARKER = '*** Update File: ';
const MOVE_MARKER = '*** Move to: ';
const END_OF_FILE_MARKER = '*** End of File';

export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_PATCH_OPERATIONS = 100;
export const MAX_PATCH_HUNKS = 1_000;
export const MAX_PATCH_LINES = 50_000;

export interface ApplyPatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
  hasChange: boolean;
  line: number;
}

export type ApplyPatchOperation =
  | {
      kind: 'add';
      path: string;
      content: string;
      line: number;
    }
  | {
      kind: 'delete';
      path: string;
      line: number;
    }
  | {
      kind: 'update';
      path: string;
      movePath?: string;
      chunks: ApplyPatchChunk[];
      line: number;
    };

export class ApplyPatchParseError extends Error {
  constructor(
    message: string,
    readonly line?: number
  ) {
    super(
      line ? `Invalid patch at line ${line}: ${message}` : `Invalid patch: ${message}`
    );
    this.name = 'ApplyPatchParseError';
  }
}

export function parseApplyPatch(input: string): ApplyPatchOperation[] {
  if (input.includes('\0')) {
    throw new ApplyPatchParseError('null bytes are not allowed');
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_PATCH_BYTES) {
    throw new ApplyPatchParseError(`patch exceeds the ${MAX_PATCH_BYTES} byte limit`);
  }

  const normalized = input.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_PATCH_LINES) {
    throw new ApplyPatchParseError(`patch exceeds the ${MAX_PATCH_LINES} line limit`);
  }
  if (lines[0] !== BEGIN_MARKER) {
    throw new ApplyPatchParseError(`first line must be "${BEGIN_MARKER}"`, 1);
  }
  if (lines.at(-1) !== END_MARKER) {
    throw new ApplyPatchParseError(`last line must be "${END_MARKER}"`, lines.length);
  }

  const operations: ApplyPatchOperation[] = [];
  let totalHunks = 0;
  let index = 1;
  while (index < lines.length - 1) {
    if (operations.length >= MAX_PATCH_OPERATIONS) {
      throw new ApplyPatchParseError(
        `patch exceeds the ${MAX_PATCH_OPERATIONS} file operation limit`,
        index + 1
      );
    }
    const header = lines[index];
    const operationLine = index + 1;

    if (header.startsWith(ADD_MARKER)) {
      const filePath = parsePatchPath(header.slice(ADD_MARKER.length), operationLine);
      index++;
      const content: string[] = [];
      while (index < lines.length - 1 && !isFileHeader(lines[index])) {
        const line = lines[index];
        if (!line.startsWith('+')) {
          throw new ApplyPatchParseError(
            'every Add File content line must start with "+"',
            index + 1
          );
        }
        content.push(line.slice(1));
        index++;
      }
      if (content.length === 0) {
        throw new ApplyPatchParseError(
          'Add File requires at least one "+" content line',
          operationLine
        );
      }
      operations.push({
        kind: 'add',
        path: filePath,
        content: `${content.join('\n')}\n`,
        line: operationLine,
      });
      continue;
    }

    if (header.startsWith(DELETE_MARKER)) {
      operations.push({
        kind: 'delete',
        path: parsePatchPath(header.slice(DELETE_MARKER.length), operationLine),
        line: operationLine,
      });
      index++;
      continue;
    }

    if (header.startsWith(UPDATE_MARKER)) {
      const filePath = parsePatchPath(
        header.slice(UPDATE_MARKER.length),
        operationLine
      );
      index++;
      let movePath: string | undefined;
      if (lines[index]?.startsWith(MOVE_MARKER)) {
        movePath = parsePatchPath(lines[index].slice(MOVE_MARKER.length), index + 1);
        index++;
      }

      const chunks: ApplyPatchChunk[] = [];
      let hasChange = false;
      while (index < lines.length - 1 && !isFileHeader(lines[index])) {
        const chunkHeader = lines[index];
        if (chunkHeader !== '@@' && !chunkHeader.startsWith('@@ ')) {
          throw new ApplyPatchParseError(
            'Update File content must begin with "@@"',
            index + 1
          );
        }
        if (++totalHunks > MAX_PATCH_HUNKS) {
          throw new ApplyPatchParseError(
            `patch exceeds the ${MAX_PATCH_HUNKS} hunk limit`,
            index + 1
          );
        }
        const chunkLine = index + 1;
        const changeContext = chunkHeader === '@@' ? undefined : chunkHeader.slice(3);
        index++;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let isEndOfFile = false;
        let chunkHasChange = false;

        while (
          index < lines.length - 1 &&
          !isFileHeader(lines[index]) &&
          lines[index] !== '@@' &&
          !lines[index].startsWith('@@ ')
        ) {
          const line = lines[index];
          if (line === END_OF_FILE_MARKER) {
            isEndOfFile = true;
            index++;
            break;
          }
          const prefix = line[0];
          if (prefix !== ' ' && prefix !== '-' && prefix !== '+') {
            throw new ApplyPatchParseError(
              'hunk lines must start with " ", "-", or "+"',
              index + 1
            );
          }
          const content = line.slice(1);
          if (prefix !== '+') oldLines.push(content);
          if (prefix !== '-') newLines.push(content);
          if (prefix !== ' ') chunkHasChange = true;
          index++;
        }

        chunks.push({
          ...(changeContext ? { changeContext } : {}),
          oldLines,
          newLines,
          isEndOfFile,
          hasChange: chunkHasChange,
          line: chunkLine,
        });
        hasChange ||= chunkHasChange;
      }

      if (!movePath && !hasChange) {
        throw new ApplyPatchParseError(
          'Update File must change content or include a Move to destination',
          operationLine
        );
      }
      operations.push({
        kind: 'update',
        path: filePath,
        ...(movePath ? { movePath } : {}),
        chunks,
        line: operationLine,
      });
      continue;
    }

    throw new ApplyPatchParseError(
      'expected Add File, Delete File, or Update File header',
      operationLine
    );
  }

  if (operations.length === 0) {
    throw new ApplyPatchParseError('patch must contain at least one file operation');
  }
  return operations;
}

export function extractApplyPatchPaths(input: string): string[] {
  return parseApplyPatch(input).flatMap((operation) =>
    operation.kind === 'update' && operation.movePath
      ? [operation.path, operation.movePath]
      : [operation.path]
  );
}

function isFileHeader(line: string | undefined): boolean {
  return Boolean(
    line?.startsWith(ADD_MARKER) ||
      line?.startsWith(DELETE_MARKER) ||
      line?.startsWith(UPDATE_MARKER)
  );
}

function parsePatchPath(value: string, line: number): string {
  if (value !== value.trim() || value.length === 0 || value.length > 4_096) {
    throw new ApplyPatchParseError('file path is empty, padded, or too long', line);
  }
  if (
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new ApplyPatchParseError('file paths must be relative POSIX paths', line);
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..'
    )
  ) {
    throw new ApplyPatchParseError(
      'file paths cannot contain empty, "." or ".." segments',
      line
    );
  }
  return value;
}
