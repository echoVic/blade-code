import { describe, expect, it } from 'vitest';
import {
  blockAnchorMatch,
  flexibleMatch,
  lineTrimMatch,
  unescapeString,
  whitespaceNormalizeMatch,
} from '../../../../src/tools/builtin/file/editCorrector.js';

describe('unescapeString', () => {
  it('should unescape newlines', () => {
    expect(unescapeString('line1\\nline2')).toBe('line1\nline2');
  });

  it('should unescape tabs', () => {
    expect(unescapeString('col1\\tcol2')).toBe('col1\tcol2');
  });

  it('should unescape double quotes', () => {
    expect(unescapeString('say \\"hello\\"')).toBe('say "hello"');
  });

  it('should unescape single quotes', () => {
    expect(unescapeString("\\'test\\'")).toBe("'test'");
  });

  it('should unescape backticks', () => {
    expect(unescapeString('\\`template\\`')).toBe('`template`');
  });

  it('should unescape double backslashes', () => {
    // 双反斜杠 \\\\ 在字符串中表示 \\，应该转义为单个 \
    expect(unescapeString('\\\\')).toBe('\\');
  });

  it('should unescape carriage returns', () => {
    expect(unescapeString('line1\\rline2')).toBe('line1\rline2');
  });

  it('should handle multiple escape characters', () => {
    expect(unescapeString('console.log(\\"Hello\\nWorld\\");')).toBe(
      'console.log("Hello\nWorld");'
    );
  });

  it('should handle already unescaped strings', () => {
    expect(unescapeString('normal text')).toBe('normal text');
  });

  it('should handle complex TypeScript code', () => {
    // LLM 可能会过度转义反引号
    const input = 'const message = \\`Hello World\\`;';
    const expected = 'const message = `Hello World`;';
    expect(unescapeString(input)).toBe(expected);
  });
});

describe('flexibleMatch', () => {
  it('should match with different indentation (2 spaces vs 4 spaces)', () => {
    const content = '  function foo() {\n    return 1;\n  }';
    const search = '    function foo() {\n      return 1;\n    }';

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('  function foo() {\n    return 1;\n  }');
  });

  it('should match with same indentation type but different levels', () => {
    // flexibleMatch 处理相同类型（都是空格）但不同级别的缩进
    // 不处理 tab vs spaces 的转换（那是不同的缩进类型）
    const content = '    function bar() {\n      return 2;\n    }';
    const search = '  function bar() {\n    return 2;\n  }';

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('    function bar() {\n      return 2;\n    }');
  });

  it('should return null if no match found', () => {
    const content = 'function bar() {}';
    const search = '    function foo() {}';

    expect(flexibleMatch(content, search)).toBeNull();
  });

  it('should return null for single-line search', () => {
    const content = 'function foo() { return 1; }';
    const search = '    function foo() { return 1; }';

    expect(flexibleMatch(content, search)).toBeNull();
  });

  it('should match multi-line code with different indentation', () => {
    const content = `function test() {
  if (condition) {
    doSomething();
  }
}`;

    const search = `    if (condition) {
      doSomething();
    }`;

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('  if (condition) {\n    doSomething();\n  }');
  });

  it('should handle no indentation on first line', () => {
    const content = 'function foo() {\n  return 1;\n}';
    const search = 'function foo() {\n    return 1;\n}';

    expect(flexibleMatch(content, search)).toBeNull();
  });

  it('should preserve original file indentation in result', () => {
    const content = '      const x = 1;\n      const y = 2;';
    const search = '  const x = 1;\n  const y = 2;';

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('      const x = 1;\n      const y = 2;');
  });

  it('should match nested code blocks', () => {
    const content = `class Example {
  constructor() {
    this.value = 1;
  }
}`;

    const search = `    constructor() {
      this.value = 1;
    }`;

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('  constructor() {\n    this.value = 1;\n  }');
  });

  it('should handle mixed indentation levels', () => {
    const content = `  function outer() {
    function inner() {
      return 42;
    }
  }`;

    const search = `    function inner() {
      return 42;
    }`;

    const result = flexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toBe('    function inner() {\n      return 42;\n    }');
  });
});

describe('lineTrimMatch', () => {
  it('should match when lines differ only by trailing whitespace', () => {
    const content = 'function foo() {\n  return 1;\n}';
    const search = 'function foo() {  \n  return 1;  \n}  ';

    const result = lineTrimMatch(content, search);
    expect(result).toBe('function foo() {\n  return 1;\n}');
  });

  it('should return null when content differs beyond whitespace', () => {
    const content = 'function foo() {\n  return 1;\n}';
    const search = 'function bar() {\n  return 1;\n}';

    expect(lineTrimMatch(content, search)).toBeNull();
  });

  it('should handle single-line input', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const search = 'const x = 1;   ';

    const result = lineTrimMatch(content, search);
    expect(result).toBe('const x = 1;');
  });

  it('should preserve original indentation in result', () => {
    const content = '    const x = 1;\n    const y = 2;';
    const search = '    const x = 1;   \n    const y = 2;  ';

    const result = lineTrimMatch(content, search);
    expect(result).toBe('    const x = 1;\n    const y = 2;');
  });
});

describe('whitespaceNormalizeMatch', () => {
  it('should match when only inline spacing differs', () => {
    const content = 'const x  =  1;\nconst y = 2;';
    const search = 'const x = 1;\nconst y = 2;';

    const result = whitespaceNormalizeMatch(content, search);
    expect(result).toBe('const x  =  1;\nconst y = 2;');
  });

  it('should match tabs vs spaces', () => {
    const content = 'function foo() {\n\treturn 1;\n}';
    const search = 'function foo() {\n  return 1;\n}';

    const result = whitespaceNormalizeMatch(content, search);
    expect(result).toBe('function foo() {\n\treturn 1;\n}');
  });

  it('should return null when content structurally differs', () => {
    const content = 'if (x) {\n  doA();\n}';
    const search = 'if (y) {\n  doB();\n}';

    expect(whitespaceNormalizeMatch(content, search)).toBeNull();
  });

  it('should handle extra spaces around operators', () => {
    const content = 'const result = a   +   b;';
    const search = 'const result = a + b;';

    const result = whitespaceNormalizeMatch(content, search);
    expect(result).toBe('const result = a   +   b;');
  });
});

describe('blockAnchorMatch', () => {
  it('should match when first/last lines are exact and middle is similar', () => {
    const content = [
      'function process() {',
      '  const a = getValue();',
      '  const b = compute(a);',
      '  const c = transform(b);',
      '  const d = format(c);',
      '  const e = validate(d);',
      '  const f = finalize(e);',
      '  return output(f);',
      '}',
    ].join('\n');

    // One middle line slightly different (comment added)
    const search = [
      'function process() {',
      '  const a = getValue();',
      '  const b = compute(a);',
      '  const c = transform(b);  // transform step',
      '  const d = format(c);',
      '  const e = validate(d);',
      '  const f = finalize(e);',
      '  return output(f);',
      '}',
    ].join('\n');

    const result = blockAnchorMatch(content, search);
    expect(result).toBe(content);
  });

  it('should return null for less than 3 lines', () => {
    const content = 'line1\nline2';
    const search = 'line1\nline2';

    expect(blockAnchorMatch(content, search)).toBeNull();
  });

  it('should return null when anchors do not match', () => {
    const content = 'function foo() {\n  return 1;\n}';
    const search = 'function bar() {\n  return 1;\n}';

    expect(blockAnchorMatch(content, search)).toBeNull();
  });

  it('should return null when middle lines have low similarity', () => {
    const content = [
      'function test() {',
      '  const a = 1;',
      '  const b = 2;',
      '  const c = 3;',
      '  const d = 4;',
      '  return a + b + c + d;',
      '}',
    ].join('\n');

    const search = [
      'function test() {',
      '  doSomethingCompletelyDifferent();',
      '  anotherUnrelatedCall();',
      '  yetMoreDifferentCode();',
      '  totallyNewLogic();',
      '  return x + y;',
      '}',
    ].join('\n');

    expect(blockAnchorMatch(content, search)).toBeNull();
  });

  it('should tolerate minor trim differences in anchors', () => {
    const content = '  if (condition) {\n    doA();\n    doB();\n  }';
    const search = 'if (condition) {\n  doA();\n  doB();\n}';

    const result = blockAnchorMatch(content, search);
    expect(result).toBe('  if (condition) {\n    doA();\n    doB();\n  }');
  });
});
