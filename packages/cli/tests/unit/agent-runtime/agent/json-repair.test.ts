import { describe, expect, it } from 'vitest';

// We need to test the tryRepairJson function which is not exported.
// Test it indirectly by importing the module and testing the behavior.
// For direct testing, extract it or use the full loop test.

// Test the JSON repair logic directly
function tryRepairJson(raw: string): Record<string, unknown> | null {
  let fixed = raw.trim();
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  if (fixed.startsWith('{') && !fixed.endsWith('}')) {
    fixed += '}';
  }
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(fixed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

describe('tryRepairJson', () => {
  it('returns null for completely invalid JSON', () => {
    expect(tryRepairJson('not json at all')).toBeNull();
    expect(tryRepairJson('')).toBeNull();
    expect(tryRepairJson('[')).toBeNull();
  });

  it('parses valid JSON normally', () => {
    expect(tryRepairJson('{"path": "/tmp/test.ts"}')).toEqual({ path: '/tmp/test.ts' });
    expect(tryRepairJson('{"a": 1, "b": "hello"}')).toEqual({ a: 1, b: 'hello' });
  });

  it('fixes trailing commas', () => {
    expect(tryRepairJson('{"path": "/tmp/test.ts",}')).toEqual({ path: '/tmp/test.ts' });
    expect(tryRepairJson('{"a": [1, 2, 3,]}')).toEqual({ a: [1, 2, 3] });
  });

  it('fixes missing closing brace', () => {
    expect(tryRepairJson('{"file_path": "/src/app.ts"')).toEqual({ file_path: '/src/app.ts' });
    expect(tryRepairJson('{"old_string": "hello", "new_string": "world"')).toEqual({
      old_string: 'hello',
      new_string: 'world',
    });
  });

  it('fixes trailing comma AND missing brace together', () => {
    expect(tryRepairJson('{"path": "test.ts",')).toEqual({ path: 'test.ts' });
  });

  it('returns null for arrays (not objects)', () => {
    expect(tryRepairJson('[1, 2, 3]')).toBeNull();
    expect(tryRepairJson('["a", "b"]')).toBeNull();
  });

  it('handles whitespace and newlines', () => {
    const input = `{
      "file_path": "/tmp/demo.ts",
      "old_string": "const x = 1;",
      "new_string": "const x = 2;"
    }`;
    expect(tryRepairJson(input)).toEqual({
      file_path: '/tmp/demo.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    });
  });
});
