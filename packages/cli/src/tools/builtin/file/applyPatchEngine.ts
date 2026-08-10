import type { ApplyPatchChunk } from './applyPatchParser.js';

export class ApplyPatchContextError extends Error {
  constructor(
    readonly filePath: string,
    readonly hunkLine: number,
    message: string
  ) {
    super(`Cannot apply patch to ${filePath} (hunk line ${hunkLine}): ${message}`);
    this.name = 'ApplyPatchContextError';
  }
}

export function applyUpdateChunks(
  originalContent: string,
  chunks: readonly ApplyPatchChunk[],
  filePath: string
): string {
  const lineEnding = detectLineEnding(originalContent);
  const normalized = originalContent.replace(/\r\n/g, '\n');
  const hadFinalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hadFinalNewline) lines.pop();

  let cursor = 0;
  let changed = false;
  for (const chunk of chunks) {
    let searchStart = cursor;
    if (chunk.changeContext) {
      const contextIndex = seekSequence(lines, [chunk.changeContext], cursor, false);
      if (contextIndex === undefined) {
        throw new ApplyPatchContextError(
          filePath,
          chunk.line,
          `context "${chunk.changeContext}" was not found`
        );
      }
      searchStart = contextIndex + 1;
      if (!chunk.hasChange) {
        cursor = searchStart;
        continue;
      }
    }

    let matchIndex: number | undefined;
    if (chunk.oldLines.length === 0) {
      matchIndex = chunk.isEndOfFile ? lines.length : searchStart;
    } else {
      matchIndex = seekSequence(lines, chunk.oldLines, searchStart, chunk.isEndOfFile);
    }
    if (matchIndex === undefined) {
      const preview = chunk.oldLines.slice(0, 3).join('\n');
      throw new ApplyPatchContextError(
        filePath,
        chunk.line,
        preview
          ? `expected context was not found:\n${preview}`
          : 'insertion point could not be resolved'
      );
    }

    if (chunk.hasChange) {
      lines.splice(matchIndex, chunk.oldLines.length, ...chunk.newLines);
      changed = true;
    }
    cursor = matchIndex + chunk.newLines.length;
  }

  if (!changed) return originalContent;
  const content = lines.join(lineEnding);
  return hadFinalNewline ? `${content}${lineEnding}` : content;
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean
): number | undefined {
  if (pattern.length === 0) return Math.min(start, lines.length);
  if (pattern.length > lines.length) return undefined;

  const lastIndex = lines.length - pattern.length;
  const searchStart = endOfFile ? lastIndex : Math.min(start, lastIndex);
  const candidates: number[] = [];
  if (endOfFile && lastIndex >= start) candidates.push(lastIndex);
  for (let index = searchStart; index <= lastIndex; index++) {
    if (!candidates.includes(index)) candidates.push(index);
  }

  const comparators = [
    (left: string, right: string) => left === right,
    (left: string, right: string) => left.trimEnd() === right.trimEnd(),
    (left: string, right: string) => left.trim() === right.trim(),
  ];
  for (const compare of comparators) {
    for (const index of candidates) {
      if (pattern.every((line, offset) => compare(lines[index + offset], line))) {
        return index;
      }
    }
  }
  return undefined;
}

function detectLineEnding(content: string): '\n' | '\r\n' {
  const firstCrLf = content.indexOf('\r\n');
  const firstLf = content.indexOf('\n');
  return firstCrLf >= 0 && firstCrLf === firstLf - 1 ? '\r\n' : '\n';
}
