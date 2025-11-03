# 🧪 测试指南

## 🎯 测试概览

Blade Code 采用完整的测试架构，确保代码质量和稳定性。

## 🏗️ 测试结构

```
tests/
├── unit/           # 单元测试 - 纯逻辑和模块行为验证
├── integration/    # 集成测试 - 跨模块协作场景
└── cli/            # CLI 行为测试 - 真实命令执行
```

## ⚡ 快速开始

### 运行所有测试

```bash
# 运行完整测试套件
npm test

# 使用 pnpm（推荐）
pnpm test
```

### 运行特定类型测试

```bash
# 单元测试
npm run test:unit

# 集成测试
npm run test:integration

# CLI 行为测试
npm run test:cli
```

### 监视模式

```bash
# 文件变更时自动运行测试
npm run test:watch

# 监视特定目录
npm run test:watch -- --testPathPattern=unit
```

## 📊 测试覆盖率

### 生成覆盖率报告

```bash
# 生成完整覆盖率报告
npm run test:coverage

# 查看覆盖率报告
open coverage/index.html
```

### 覆盖率目标

- **语句覆盖率**: ≥ 40%
- **分支覆盖率**: ≥ 50%
- **函数覆盖率**: ≥ 40%
- **行覆盖率**: ≥ 40%

## 🔧 测试工具栈

### 核心工具
- **[Vitest](https://vitest.dev/)**: 测试框架（快速、现代化）
- **Vitest 扩展 API**: 熟悉的断言与 Mock 能力
- **V8 Coverage**: 内置覆盖率报告

### 测试工具
- **@testing-library**: DOM 测试工具
- **MSW**: API 模拟
- **Mock Functions**: 函数模拟
- **Snapshot Testing**: 快照测试

## 📝 编写测试

### 单元测试示例

```typescript
// tests/unit/utils/package-info.test.ts
import { describe, it, expect } from 'vitest'
import { getVersion, getPackageInfo } from '../../../src/utils/package-info'

describe('package-info', () => {
  it('should return current version', () => {
    const version = getVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('should return package information', () => {
    const info = getPackageInfo()
    expect(info).toHaveProperty('name', 'blade-code')
    expect(info).toHaveProperty('version')
    expect(info).toHaveProperty('description')
  })
})
```

### 集成测试示例

```typescript
// tests/integration/agent/agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Agent } from '../../../src/agent/Agent'
import { ToolManager } from '../../../src/tools/ToolManager'

describe('Agent Integration', () => {
  it('should handle tool execution flow', async () => {
    const toolManager = new ToolManager()
    const agent = new Agent({ toolManager })

    const mockTool = vi.fn().mockResolvedValue({ result: 'success' })
    toolManager.register('test-tool', mockTool)

    const result = await agent.execute({
      message: 'use test-tool',
      tools: ['test-tool']
    })

    expect(mockTool).toHaveBeenCalled()
    expect(result).toContain('success')
  })
})
```

### CLI 测试示例

```typescript
// tests/cli/blade-help.test.ts
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const CLI_ENTRY = path.resolve('dist', 'blade.js')

describe('Blade CLI', () => {
  it('--help 输出应包含命令信息', () => {
    if (!existsSync(CLI_ENTRY)) {
      // 首次运行需要先执行 npm run build
      return
    }

    const result = spawnSync('node', [CLI_ENTRY, '--help'], {
      encoding: 'utf-8'
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('blade')
  })
})
```

## 🎨 测试最佳实践

### 1. 测试命名规范

```typescript
// ✅ 好的测试名称
describe('UserService', () => {
  it('should return user when valid ID is provided', () => {})
  it('should throw error when user not found', () => {})
})

// ❌ 不好的测试名称
describe('UserService', () => {
  it('test user', () => {})
  it('user error', () => {})
})
```

### 2. AAA 模式（Arrange-Act-Assert）

```typescript
it('should calculate total price with tax', () => {
  // Arrange - 准备测试数据
  const items = [{ price: 100 }, { price: 200 }]
  const taxRate = 0.1

  // Act - 执行被测试的操作
  const total = calculateTotalWithTax(items, taxRate)

  // Assert - 验证结果
  expect(total).toBe(330)
})
```

### 3. Mock 和 Stub 使用

```typescript
import { vi } from 'vitest'

// Mock 外部依赖
vi.mock('../../../src/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue('mocked response')
  }))
}))

// Spy 函数调用
const consoleSpy = vi.spyOn(console, 'log')
expect(consoleSpy).toHaveBeenCalledWith('expected message')
```

## 🚀 持续集成

### GitHub Actions 配置

测试在 CI/CD 中自动运行：

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    name: Test Suite (${{ matrix.node-version }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]

    steps:
    - name: Run tests
      run: pnpm test

    - name: Run type check
      run: pnpm run type-check

    - name: Generate coverage
      run: pnpm run test:coverage

    - name: Upload coverage
      uses: codecov/codecov-action@v3
```

### 测试脚本

```json
{
  "scripts": {
    "test": "node scripts/test.js",
    "test:unit": "node scripts/test.js unit",
    "test:integration": "node scripts/test.js integration",
    "test:cli": "node scripts/test.js cli",
    "test:coverage": "node scripts/test.js all --coverage",
    "test:watch": "vitest --watch --config vitest.config.ts",
    "test:unit:watch": "vitest --watch --config vitest.config.ts --project unit",
    "test:integration:watch": "vitest --watch --config vitest.config.ts --project integration",
    "test:cli:watch": "vitest --watch --config vitest.config.ts --project cli"
  }
}
```

## 🐛 调试测试

### 调试单个测试

```bash
# 运行单个测试文件
npm test -- tests/unit/utils/package-info.test.ts

# 调试模式
npm run test:debug -- tests/unit/specific-test.test.ts

# 详细输出
npm test -- --reporter=verbose
```

### 测试选项

```bash
# 只运行匹配的测试
npm test -- --testNamePattern="should handle errors"

# 跳过特定测试
npm test -- --testPathIgnorePatterns=cli

# 并行运行
npm test -- --maxWorkers=4

# 单次运行（不监视）
npm test -- --run
```

## 📈 性能测试

### 基准测试

```typescript
// tests/performance/benchmark.test.ts
import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'

describe('Performance Tests', () => {
  it('should process large input within time limit', () => {
    const largeData = generateLargeDataSet()

    const start = performance.now()
    const result = processLargeData(largeData)
    const end = performance.now()

    expect(end - start).toBeLessThan(1000) // 1 second
    expect(result).toBeDefined()
  })
})
```

## 📚 测试资源

### 测试数据

```typescript
// tests/fixtures/test-data.ts
export const mockConversation = {
  id: 'test-conversation-1',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' }
  ],
  created: new Date().toISOString()
}

export const mockApiResponse = {
  choices: [
    {
      message: { role: 'assistant', content: 'Test response' },
      finish_reason: 'stop'
    }
  ]
}
```

### 测试工具

```typescript
// tests/utils/test-helpers.ts
export function createMockAgent(options = {}) {
  return {
    execute: vi.fn(),
    setContext: vi.fn(),
    ...options
  }
}

export async function waitForAsync(ms = 100) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

## ✅ 测试检查清单

在提交代码前确保：

- [ ] 所有测试通过
- [ ] 新功能有对应测试
- [ ] 测试覆盖率达标
- [ ] 无测试警告或错误
- [ ] 安全测试通过
- [ ] 性能测试在可接受范围内

## 🔗 相关链接

- [Vitest 官方文档](https://vitest.dev/)
- [Testing Library 文档](https://testing-library.com/)
- [代码覆盖率最佳实践](https://istanbul.js.org/)

---

完善的测试让 Blade Code 更加稳定可靠！🧪✨
