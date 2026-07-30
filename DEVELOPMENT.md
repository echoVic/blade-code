# 开发工作流

本文档描述 Blade Code 的开发工作流和最佳实践。

## 设计优先原则

在实现任何非琐碎的功能或变更之前：

1. **头脑风暴** - 使用 `/spec:brainstorm` 命令生成设计文档
2. **竞品研究** - 查看类似功能的实现：
   - 检查 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
   - 查看 Cursor、Aider、Copilot 等竞品
   - 理解竞品如何解决类似问题
3. **评审** - 在团队中讨论设计方案
4. **迭代** - 根据反馈优化设计后再编写代码

这种方法可以减少返工，确保实现方向的一致性。

**跳过此流程的情况**：
- 修复拼写错误
- 简单的 bug 修复
- 文档更新

**设计文档存储**：`docs/designs/YYYY-MM-DD-feature-name.md`

## TDD 开发方法

Blade Code 采用 **测试驱动开发（TDD）** 方法：

### TDD 三步骤

1. **🔴 Red** - 先写失败的测试
2. **🟢 Green** - 实现功能使测试通过
3. **🔵 Refactor** - 重构优化代码

### TDD 示例

```typescript
// 1. Red - 先写测试
describe('At - 文件引用系统', () => {
  it('应该提取简单的文件引用', () => {
    const at = new At({ cwd: '/test' });
    const paths = at.extractAtPaths('请查看 @src/utils.ts 文件');
    expect(paths).toEqual([{ path: 'src/utils.ts' }]);
  });
});

// 2. Green - 实现功能
export class At {
  extractAtPaths(prompt: string): AtPath[] {
    const atRegex = /@([a-zA-Z0-9/_.-]+)/g;
    // ... 实现逻辑
  }
}

// 3. Refactor - 优化代码
// - 提取常量
// - 改进正则表达式
// - 添加错误处理
```

### TDD 优势

- ✅ 清晰的功能规格（测试即文档）
- ✅ 更高的代码质量
- ✅ 更好的边界情况处理
- ✅ 重构更有信心
- ✅ 减少 bug 数量

## Pull Request 指南

### 保持 PR 小而专注

- 将大功能拆分为增量、可审查的 PR
- 每个 PR 关注单一问题
- 小 PR 更容易审查，更安全

### PR 内容要求

- **永远不要留空 PR 或 issue 内容** - 空内容不会触发通知
- 提供清晰的变更描述和原因
- 包含测试用例
- 更新相关文档

### 创建 PR 前

1. 运行 `bun run ready` 确保所有检查通过
2. 确保所有测试通过
3. 更新 CHANGELOG.md（如果适用）
4. 编写清晰的 commit 消息

### Git 实践

- **禁止强制推送** 到共享分支
- 编写清晰、描述性的 commit 消息
- 使用约定式提交（Conventional Commits）：
  ```
  feat: 添加 @ 文件引用功能
  fix: 修复压缩系统的内存泄漏
  docs: 更新开发工作流文档
  test: 添加后台任务管理器测试
  refactor: 重构工具系统架构
  ```

## 日常开发流程

### 1. 启动开发环境

```bash
# 安装依赖
bun install

# 启动 CLI 开发模式（带热重载）
bun run dev

# 或启动 CLI + Web 开发模式
bun run dev:web
```

### 2. 开发新功能

```bash
# 1. 创建功能分支
git checkout -b feat/new-feature

# 2. 编写测试（TDD）
# 创建 tests/unit/new-feature.test.ts

# 3. 运行测试（应该失败）
bun run test:unit

# 4. 实现功能
# 编写 src/utils/new-feature.ts

# 5. 运行测试（应该通过）
bun run test:unit

# 6. 重构优化
# 改进代码质量

# 7. 运行完整检查
bun run ready
```

### 3. 提交代码

```bash
# 格式化代码
bun run format

# Lint 检查
bun run lint

# 提交
git add .
git commit -m "feat: 添加新功能"

# 推送
git push origin feat/new-feature
```

## 测试策略

### 测试层次

```
📊 测试金字塔
    ┌─────────┐
    │   E2E   │  端到端测试（少量）
    ├─────────┤
    │ 集成测试 │  模块间交互（适量）
    ├─────────┤
    │ 单元测试 │  独立函数/类（大量）
    └─────────┘
```

### 测试命令

```bash
# 单元测试
bun run test:unit

# 集成测试
bun run test:integration

# E2E 测试
bun run test:e2e

# 所有测试
bun run test:all

# 监听模式
bun run test:watch

# 覆盖率报告
bun run test:coverage
```

### 测试编写原则

1. **测试行为，不是实现**
   ```typescript
   // ❌ 不好 - 测试实现细节
   expect(at.atRegex).toBeDefined();
   
   // ✅ 好 - 测试行为
   expect(at.extractAtPaths('@file.ts')).toEqual([...]);
   ```

2. **使用描述性的测试名称**
   ```typescript
   // ❌ 不好
   it('test 1', () => {});
   
   // ✅ 好
   it('应该提取带行号范围的文件引用', () => {});
   ```

3. **每个测试只测一件事**
   ```typescript
   // ❌ 不好 - 测试多个功能
   it('应该工作', () => {
     expect(fn1()).toBe(true);
     expect(fn2()).toBe(true);
     expect(fn3()).toBe(true);
   });
   
   // ✅ 好 - 每个测试一个功能
   it('应该提取文件路径', () => {
     expect(extractPath('@file.ts')).toBe('file.ts');
   });
   
   it('应该提取行号', () => {
     expect(extractLine('@file.ts:10')).toBe(10);
   });
   ```

4. **测试边界情况**
   ```typescript
   describe('边界情况', () => {
     it('应该处理空输入', () => {});
     it('应该处理超大文件', () => {});
     it('应该处理特殊字符', () => {});
   });
   ```

## 代码审查清单

### 功能性
- [ ] 实现了所有需求
- [ ] 处理了边界情况
- [ ] 错误处理完善
- [ ] 性能可接受

### 测试
- [ ] 有单元测试
- [ ] 测试覆盖率 > 80%
- [ ] 所有测试通过
- [ ] 包含边界情况测试

### 代码质量
- [ ] 类型定义完整
- [ ] 无 `any` 类型
- [ ] 代码可读性好
- [ ] 注释清晰（必要时）

### 文档
- [ ] 更新了 README（如需要）
- [ ] 更新了 CHANGELOG
- [ ] API 文档完整
- [ ] 示例代码正确

### 性能
- [ ] 无明显性能问题
- [ ] 内存使用合理
- [ ] 无不必要的重复计算

## 发布流程

### 1. 准备发布

```bash
# 1. 确保在 main 分支
git checkout main
git pull origin main

# 2. 运行完整检查
bun run ready

# 3. 更新版本号和 CHANGELOG
# 编辑 package.json 和 CHANGELOG.md
```

### 2. 发布

```bash
# Patch 版本 (0.0.x)
bun run release:patch

# Minor 版本 (0.x.0)
bun run release:minor

# Major 版本 (x.0.0)
bun run release:major

# 测试发布（不实际发布）
bun run release:dry
```

### 3. 发布后

```bash
# 1. 验证发布
npm info blade-code

# 2. 测试安装
npm install -g blade-code@latest

# 3. 发布公告
# - GitHub Release
# - Discord/社区通知
```

## 常见问题

### Q: 测试失败怎么办？

1. 仔细阅读错误信息
2. 检查测试是否正确
3. 使用 `--debug` 模式运行
4. 查看 CI 日志

### Q: 如何调试？

```bash
# 1. 使用 debug 模式
DEBUG=blade:* bun run dev

# 2. 在代码中添加断点
debugger;

# 3. 使用 console.log（临时）
console.log('Debug:', value);

# 4. 使用 IDE 调试器
```

### Q: 如何处理合并冲突？

```bash
# 1. 拉取最新代码
git pull origin main

# 2. 解决冲突
# 编辑冲突文件

# 3. 标记为已解决
git add .

# 4. 完成合并
git commit

# 5. 推送
git push
```

## 工具推荐

### IDE 扩展
- **TypeScript**: 类型检查和智能提示
- **Biome**: 代码格式化和 Lint
- **Vitest**: 测试运行器

### CLI 工具
- **Bun**: 快速的 JavaScript 运行时
- **gh**: GitHub CLI
- **jq**: JSON 处理

## 参考资源

- [TypeScript 官方文档](https://www.typescriptlang.org/)
- [Vitest 文档](https://vitest.dev/)
- [React 文档](https://react.dev/)
- [Ink 文档](https://github.com/vadimdemedes/ink)

---

有问题？请在 [GitHub Issues](https://github.com/echoVic/blade-code/issues) 提问。
