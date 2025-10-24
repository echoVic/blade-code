# Markdown 支持

Blade 提供完整的 Markdown 渲染支持，让 AI 助手的输出更加清晰易读。

## 支持的 Markdown 特性

### 📝 内联格式

| 语法 | 效果 | 示例 |
|------|------|------|
| `**粗体**` | 粗体文本 | **这是粗体** |
| `*斜体*` 或 `_斜体_` | 斜体文本 | *这是斜体* |
| `~~删除线~~` | 删除线文本 | ~~删除的文本~~ |
| `` `内联代码` `` | 带背景色的代码 | `code here` |
| `[链接文本](URL)` | 显示链接文本和 URL | [示例](https://example.com) |
| `https://example.com` | 自动识别 URL | https://example.com |

### 📌 标题

支持 4 级标题，不同级别有不同的样式：

```markdown
# 一级标题（粗体 + 主题色）
## 二级标题（粗体 + 主题色）
### 三级标题（粗体）
#### 四级标题（斜体 + 暗色）
```

### 📋 列表

**无序列表**：

```markdown
- 列表项 1
- 列表项 2
  - 嵌套列表项
- 列表项 3
```

**有序列表**：

```markdown
1. 第一项
2. 第二项
   1. 嵌套项
3. 第三项
```

### 💻 代码块

支持 140+ 语言的语法高亮：

````markdown
```python
def hello():
    print("Hello, Blade!")
```
````

**特性**：
- ✅ 语法高亮（使用 lowlight）
- ✅ 行号显示
- ✅ 语言标签
- ✅ 圆角边框
- ✅ 智能截断（长代码块性能优化）

### 📊 表格

支持 GitHub 风格的表格：

```markdown
| 列 1 | 列 2 | 列 3 |
|------|------|------|
| 数据 1 | 数据 2 | 数据 3 |
| 数据 4 | 数据 5 | 数据 6 |
```

**特性**：
- ✅ 自动计算列宽
- ✅ 自动缩放以适应终端宽度
- ✅ 智能截断过长内容（保留 Markdown 格式）
- ✅ 美观的 Unicode 边框
- ✅ 表头粗体高亮

### ➖ 水平线

```markdown
---
```

渲染为终端宽度的水平分隔线。

## 实际示例

### 示例 1：混合格式

**输入**：

```markdown
# Blade Markdown 渲染器

Blade 支持 **完整的** Markdown 格式，包括：

- **粗体** 和 *斜体*
- `内联代码` 高亮
- [链接](https://github.com)

## 代码示例

\```typescript
const greeting = "Hello, Blade!";
console.log(greeting);
\```

## 表格示例

| 特性 | 状态 |
|------|------|
| 标题 | ✅ |
| 列表 | ✅ |
| 表格 | ✅ |
```

**输出**：

所有格式都会正确渲染，粗体、斜体、代码高亮、表格等都会按照主题样式显示。

### 示例 2：嵌套列表

**输入**：

```markdown
1. 第一步：安装 Blade
   - 使用 npm: `npm install -g blade-code`
   - 使用 pnpm: `pnpm add -g blade-code`
2. 第二步：配置 API Key
   - 运行 `blade mcp setup`
   - 输入您的 **API Key**
3. 第三步：开始使用
```

**输出**：

列表会正确缩进，嵌套层级清晰，内联代码和粗体格式正确渲染。

## 主题支持

Markdown 渲染完全集成 Blade 主题系统：

- **标题颜色**：使用主题的 `primary` 颜色
- **内联代码**：使用主题的 `accent` 颜色
- **链接**：使用主题的 `info` 颜色
- **表格边框**：使用主题的 `text.muted` 颜色

切换主题时，所有 Markdown 元素会自动适配新主题。

## 性能优化

Blade 的 Markdown 渲染器包含多项性能优化：

1. **代码块智能截断**：长代码块仅高亮可见行，显著提升性能
2. **表格自动缩放**：自动适应终端宽度，避免溢出
3. **纯文本快速路径**：不包含 Markdown 标记的文本跳过解析
4. **内联格式优化**：使用单次正则匹配，避免多次遍历

## 与 AI 助手的集成

当 AI 助手返回 Markdown 格式的内容时，Blade 会自动渲染：

```
用户：请解释 TypeScript 的类型系统

助手：# TypeScript 类型系统

TypeScript 提供强大的类型系统，主要特性包括：

## 基础类型

- `string`：字符串
- `number`：数字
- `boolean`：布尔值

## 示例代码

\```typescript
let name: string = "Blade";
let age: number = 1;
\```

（以上内容会自动渲染为格式化的 Markdown）
```

## 常见问题

### 为什么我的斜体没有渲染？

确保斜体标记（`*` 或 `_`）前后不是字母或数字，避免误判文件路径：

- ✅ `这是 *斜体* 文本`
- ❌ `file_name.txt`（不会渲染为斜体）

### 如何在代码块中显示 Markdown 语法？

使用更多反引号包围：

````markdown
\`\`\`markdown
\`\`\`python
print("Hello")
\`\`\`
\`\`\`
````

### 表格为什么被截断了？

表格会自动缩放以适应终端宽度。如果终端太窄，单元格内容会被智能截断（保留 Markdown 格式）。

尝试扩大终端窗口或减少列数。

## 相关文档

- [主题配置](../configuration/themes.md)
- [CLI 命令参考](../reference/cli-commands.md)
- [开发者文档 - Markdown 渲染器](../../development/implementation/markdown-renderer.md)
