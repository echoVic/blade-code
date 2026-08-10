import { describe, expect, it } from 'vitest';
import {
  ApplyPatchContextError,
  applyUpdateChunks,
  seekSequence,
} from '../../../../../../src/tools/builtin/file/applyPatchEngine.js';
import { parseApplyPatch } from '../../../../../../src/tools/builtin/file/applyPatchParser.js';

function updateChunks(patchBody: string) {
  const [operation] = parseApplyPatch(
    `*** Begin Patch\n*** Update File: source.ts\n${patchBody}\n*** End Patch`
  );
  if (operation.kind !== 'update') throw new Error('Expected update operation');
  return operation.chunks;
}

describe('ApplyPatch engine', () => {
  it('applies ordered hunks after a semantic locator', () => {
    const source = [
      'class Service {',
      '  run() {',
      '    const value = false;',
      '    return value;',
      '  }',
      '}',
      '',
    ].join('\n');
    const chunks = updateChunks(`@@ class Service {
@@   run() {
-    const value = false;
+    const value = true;
     return value;`);

    expect(applyUpdateChunks(source, chunks, 'source.ts')).toContain(
      '    const value = true;\n    return value;'
    );
  });

  it('supports insertions and end-of-file matching', () => {
    const chunks = updateChunks(`@@
 const first = 1;
+const middle = 2;
 const last = 3;
@@
+export {};
*** End of File`);

    expect(
      applyUpdateChunks('const first = 1;\nconst last = 3;\n', chunks, 'source.ts')
    ).toBe('const first = 1;\nconst middle = 2;\nconst last = 3;\nexport {};\n');
  });

  it('preserves CRLF and a missing final newline', () => {
    const chunks = updateChunks(`@@
-const value = false;
+const value = true;`);

    expect(
      applyUpdateChunks('const value = false;\r\nconst tail = 1;', chunks, 'source.ts')
    ).toBe('const value = true;\r\nconst tail = 1;');
  });

  it('uses bounded whitespace tolerance but rejects missing context', () => {
    const chunks = updateChunks(`@@
-const value = false;
+const value = true;`);
    expect(applyUpdateChunks('  const value = false;  \n', chunks, 'source.ts')).toBe(
      'const value = true;\n'
    );
    expect(() =>
      applyUpdateChunks('const other = false;\n', chunks, 'source.ts')
    ).toThrow(ApplyPatchContextError);
  });

  it('searches from the previous hunk instead of rewriting an earlier duplicate', () => {
    const chunks = updateChunks(`@@ first
-value
+one
@@ second
-value
+two`);
    const source = 'first\nvalue\nsecond\nvalue\n';

    expect(applyUpdateChunks(source, chunks, 'source.ts')).toBe(
      'first\none\nsecond\ntwo\n'
    );
  });

  it('matches exact content before applying whitespace tolerance', () => {
    expect(seekSequence([' x ', 'x'], ['x'], 0, false)).toBe(1);
  });
});
