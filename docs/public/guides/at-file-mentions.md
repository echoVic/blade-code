# @ 文件提及功能

> **版本要求**: Blade Code v0.0.12+
> **状态**: ✅ 生产就绪

## 概述

@ 文件提及功能允许你在对话中直接引用项目文件，Blade 会自动读取文件内容并作为上下文发送给 AI。这让你可以更方便地讨论代码、分析文件内容或进行代码审查。

## 快速开始

### 使用步骤

1. **启动 Blade**
   ```bash
   blade
   ```

2. **输入 @ 触发自动补全**
   ```
   > 请帮我分析 @src/
   ```
   输入 `@` 后会自动显示文件建议列表

3. **使用键盘导航选择文件**
   - ↑↓ : 在建议列表中导航
   - Tab : 选择当前高亮的文件
   - Esc : 取消建议

4. **按 Enter 发送消息**
   Blade 会自动读取文件并让 AI 分析

### 基础语法

```
@path/to/file.ts          # 引用整个文件
@"path with spaces.ts"    # 路径包含空格时使用引号
@file.ts#L10              # 引用第 10 行
@file.ts#L10-20           # 引用第 10-20 行
@src/                     # 引用整个目录（递归）
```

### 使用示例

#### 示例 1: 分析单个文件

```
用户: 帮我分析 @src/agent/Agent.ts 中的错误处理逻辑
```

Blade 会自动读取 `Agent.ts` 文件内容，并将其追加到你的消息中发送给 AI。

#### 示例 2: 指定行号范围

```
用户: 解释 @src/agent/Agent.ts#L100-150 这段代码的作用
```

Blade 只会读取 100-150 行的内容，并自动添加行号方便阅读。

#### 示例 3: 对比多个文件

```
用户: 对比 @src/agent/Agent.ts 和 @src/agent/ExecutionEngine.ts 的实现差异
```

可以同时引用多个文件，Blade 会分别读取并追加到消息中。

#### 示例 4: 引用目录

```
用户: 分析 @src/utils/ 目录下的工具函数
```

Blade 会递归读取目录下的所有文件（排除 `node_modules` 等）。

## 详细说明

### 支持的语法格式

| 语法 | 说明 | 示例 |
|-----|-----|-----|
| `@path` | 裸路径（无空格） | `@src/index.ts` |
| `@"path"` | 带引号路径（有空格） | `@"my file.ts"` |
| `@path#L10` | 单行引用 | `@config.json#L5` |
| `@path#L10-20` | 行范围引用 | `@agent.ts#L100-150` |
| `@directory/` | 目录引用 | `@src/utils/` |

### 路径解析规则

1. **相对路径**: 相对于项目根目录解析
   ```
   @src/agent.ts  → /project/src/agent.ts
   ```

2. **绝对路径**: 必须在工作区内
   ```
   @/Users/you/project/src/agent.ts  → ✅ 允许（在工作区内）
   @/etc/passwd                       → ❌ 拒绝（在工作区外）
   ```

3. **路径遍历**: 禁止使用 `..` 跳出工作区
   ```
   @../../etc/passwd  → ❌ 拒绝
   ```

### 安全限制

为了保护你的系统安全，以下路径被禁止访问：

- `.git/` - Git 仓库目录
- `.claude/` - Blade 配置目录
- `node_modules/` - 依赖包目录
- `.env`, `.env.local` 等 - 环境变量文件

尝试访问这些路径会返回错误提示，但不会中断对话。

### 文件大小限制

| 限制项 | 默认值 | 说明 |
|-------|-------|-----|
| 最大文件大小 | 1 MB | 超过会提示错误 |
| 最大行数 | 2000 行 | 超过会自动截断 |
| 最大目录文件数 | 50 个 | 超过会省略多余文件 |

### 行号引用

使用行号引用时，Blade 会：
1. 自动添加行号前缀方便阅读
2. 验证行号范围是否有效
3. 在文件内容前显示元数据

**示例输出：**
```
<file path="src/agent.ts" range=" (lines 100-150)">
100: export class Agent {
101:   private config: Config;
102:   ...
150: }
</file>
```

## 高级用法

### 多文件引用

一次对话中可以引用多个文件：

```
用户: 基于 @package.json 和 @tsconfig.json 的配置，
     帮我优化 @src/index.ts 的导入语句
```

Blade 会按顺序读取所有文件，并将它们的内容一起发送给 AI。

### 与其他功能结合

@ 文件提及可以与其他 Blade 功能无缝结合：

#### 结合 Plan 模式

```bash
blade --permission-mode plan

用户: 基于 @README.md 的说明，制定一个实现计划
```

AI 会先调研文件内容，然后输出详细的实现计划。

#### 结合工具调用

```
用户: 读取 @src/config.ts，然后使用 Write 工具创建一个类似的配置模板
```

AI 可以先通过 @ 提及获取文件内容，然后调用工具进行操作。

### 目录引用最佳实践

引用目录时，Blade 会递归读取所有文件。为了避免内容过多：

1. **引用特定子目录**: `@src/utils/` 而不是 `@src/`
2. **结合行号过滤**: 先查看目录结构，再针对性引用具体文件
3. **使用忽略模式**: Blade 自动忽略 `node_modules`, `.git` 等常见目录

## 文件缓存

Blade 会缓存读取的文件内容（60 秒），在同一会话中重复引用相同文件时会直接使用缓存，提升性能。

**缓存行为：**
- ✅ 同一文件在 60 秒内重复引用会命中缓存
- ✅ 不同行号范围会重新读取
- ✅ 文件修改后下次引用会自动刷新

## 常见问题

### Q: 为什么我的文件引用失败了？

**可能原因：**
1. **文件不存在**: 检查路径拼写是否正确
2. **在受限目录**: 尝试访问 `.git`, `node_modules` 等
3. **路径遍历**: 使用了 `..` 跳出工作区
4. **文件过大**: 超过 1 MB 限制

**解决方法：**
- 使用相对路径从项目根目录引用
- 避免引用受限目录中的文件
- 对于大文件，使用行号范围引用部分内容

### Q: 如何引用路径中包含空格的文件？

使用双引号包裹路径：

```
@"my folder/my file.ts"
```

### Q: @ 提及会消耗多少 Token？

文件内容会追加到你的消息中，Token 消耗取决于文件大小：
- 粗略估算：1 Token ≈ 4 字符
- 限制：单次对话最多 32k tokens
- 建议：使用行号范围引用减少 Token 消耗

### Q: 可以引用二进制文件吗？

❌ 不支持。Blade 只能读取文本文件。尝试引用二进制文件（如图片、PDF）会返回错误。

### Q: 为什么目录引用只显示了部分文件？

出于性能考虑，目录引用限制为最多 50 个文件。如果目录下文件过多，建议：
- 引用更具体的子目录
- 或直接引用需要的文件

## 技术细节

### 消息格式

@ 提及处理后的消息格式示例：

```xml
原始消息内容

<system-reminder>
The following files were mentioned with @ syntax:

<file path="src/agent.ts" range=" (lines 100-150)">
100: export class Agent {
101:   ...
</file>

<file path="src/config.ts">
export const config = {
  ...
};
</file>
</system-reminder>
```

### 错误处理

如果某个文件读取失败，Blade 会：
1. 继续处理其他文件
2. 在消息末尾追加错误信息
3. 不会中断对话流程

```
原始消息内容

<system-reminder>
...成功的文件内容...
</system-reminder>

⚠️ Some files could not be loaded:
- @missing.ts: Path not found: missing.ts
- @.git/config: Access denied: ".git" is a protected directory
```

## 相关资源

- [配置系统](../configuration/config-system.md) - 了解 Blade 配置
- [权限控制](../configuration/permissions.md) - 了解文件访问权限
- [CLI 命令](../reference/cli-commands.md) - 命令行参考
