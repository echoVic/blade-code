import { describe, expect, it } from 'vitest';
import {
  ApplyPatchParseError,
  extractApplyPatchPaths,
  parseApplyPatch,
} from '../../../../../../src/tools/builtin/file/applyPatchParser.js';

describe('ApplyPatch parser', () => {
  it('parses add, delete, update, move, and locator hunks', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const added = true;
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@ class Service
@@ run()
 const before = 1;
-const value = false;
+const value = true;
*** End of File
*** Delete File: src/gone.ts
*** End Patch`;

    expect(parseApplyPatch(patch)).toEqual([
      {
        kind: 'add',
        path: 'src/new.ts',
        content: 'export const added = true;\n',
        line: 2,
      },
      {
        kind: 'update',
        path: 'src/old.ts',
        movePath: 'src/moved.ts',
        chunks: [
          {
            changeContext: 'class Service',
            oldLines: [],
            newLines: [],
            isEndOfFile: false,
            hasChange: false,
            line: 6,
          },
          {
            changeContext: 'run()',
            oldLines: ['const before = 1;', 'const value = false;'],
            newLines: ['const before = 1;', 'const value = true;'],
            isEndOfFile: true,
            hasChange: true,
            line: 7,
          },
        ],
        line: 4,
      },
      {
        kind: 'delete',
        path: 'src/gone.ts',
        line: 12,
      },
    ]);
    expect(extractApplyPatchPaths(patch)).toEqual([
      'src/new.ts',
      'src/old.ts',
      'src/moved.ts',
      'src/gone.ts',
    ]);
  });

  it.each([
    ['missing begin', 'bad\n*** End Patch'],
    ['missing end', '*** Begin Patch\n*** Delete File: file.ts'],
    ['absolute path', '*** Begin Patch\n*** Add File: /tmp/file.ts\n+x\n*** End Patch'],
    ['traversal', '*** Begin Patch\n*** Add File: ../file.ts\n+x\n*** End Patch'],
    [
      'backslash path',
      '*** Begin Patch\n*** Add File: src\\file.ts\n+x\n*** End Patch',
    ],
    [
      'unprefixed add content',
      '*** Begin Patch\n*** Add File: file.ts\ntext\n*** End Patch',
    ],
    [
      'unprefixed hunk content',
      '*** Begin Patch\n*** Update File: file.ts\n@@\ntext\n*** End Patch',
    ],
    [
      'no-op update',
      '*** Begin Patch\n*** Update File: file.ts\n@@ marker\n context\n*** End Patch',
    ],
    ['padded path', '*** Begin Patch\n*** Delete File: file.ts \n*** End Patch'],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseApplyPatch(patch)).toThrow(ApplyPatchParseError);
  });

  it('normalizes CRLF without changing patch content semantics', () => {
    const operations = parseApplyPatch(
      '*** Begin Patch\r\n*** Add File: value.txt\r\n+one\r\n+two\r\n*** End Patch\r\n'
    );

    expect(operations[0]).toMatchObject({
      kind: 'add',
      content: 'one\ntwo\n',
    });
  });

  it('accepts exactly 100 file operations and rejects 101 with the authoritative limit error', () => {
    const buildPatch = (count: number) =>
      [
        '*** Begin Patch',
        ...Array.from({ length: count }, (_, index) => [
          `*** Add File: src/file-${String(index).padStart(3, '0')}.ts`,
          `+export const value${index} = ${index};`,
        ]).flat(),
        '*** End Patch',
      ].join('\n');

    expect(parseApplyPatch(buildPatch(100))).toHaveLength(100);
    expect(() => parseApplyPatch(buildPatch(101))).toThrow(
      'patch exceeds the 100 file operation limit'
    );
  });
});
