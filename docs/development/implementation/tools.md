# 🧰 Blade 工具系统

Blade 提供强大而灵活的工具系统，支持文件操作、搜索、Shell 命令、网络请求等多种功能。

## 📚 架构文档

- **[工具系统架构](../architecture/tool-system.md)** - 完整的架构设计文档 ⭐
- **[工具使用指南](./TOOL_USAGE_GUIDE.md)** - 开发者使用指南
- **[源码 README](../../src/tools/README.md)** - 源码目录说明

## 🔧 工具分类

### 文件操作工具（4个）

| 工具 | 说明 | 主要功能 |
|------|------|----------|
| `read` | 读取文件 | 支持文本、图片、PDF等多种格式 |
| `write` | 写入文件 | 支持编码、备份、目录创建 |
| `edit` | 编辑文件 | 字符串替换、正则匹配 |
| `multi_edit` | 批量编辑 | 一次执行多个编辑操作 |

### 搜索工具（3个）

| 工具 | 说明 | 主要功能 |
|------|------|----------|
| `glob` | 文件模式匹配 | 使用 glob 模式查找文件 |
| `grep` | 内容搜索 | 在文件中搜索文本内容 |
| `find` | 文件查找 | 根据条件查找文件（名称、大小、时间等） |

### Shell 命令工具（3个）

| 工具 | 说明 | 主要功能 |
|------|------|----------|
| `bash` | Bash 命令 | 执行 Bash 命令，支持后台运行 |
| `shell` | 通用 Shell | 执行 Shell 命令，自动处理环境 |
| `script` | 脚本执行 | 执行脚本文件（支持多种解释器） |

### 网络工具（2个）

| 工具 | 说明 | 主要功能 |
|------|------|----------|
| `web_fetch` | 网页抓取 | 获取网页内容，支持Markdown转换 |
| `api_call` | API 调用 | RESTful API 请求，支持认证 |

### 任务管理工具（1个）

| 工具 | 说明 | 主要功能 |
|------|------|----------|
| `task` | 任务代理 | 启动子Agent处理复杂任务 |

## 🔌 MCP 协议支持

Blade 支持通过 **Model Context Protocol (MCP)** 扩展外部工具。MCP 工具会自动转换为标准 Tool 接口。

**详细文档**: [MCP 协议支持](../protocols/mcp-support.md)

## 🚀 快速开始

### 创建自定义工具

```typescript
import { createTool } from '@/tools/core';
import { ToolKind } from '@/tools/types';
import { z } from 'zod';

export const myTool = createTool({
  name: 'my_tool',
  displayName: '我的工具',
  kind: ToolKind.Other,

  schema: z.object({
    input: z.string().describe('输入参数'),
  }),

  description: {
    short: '工具简短描述',
  },

  async execute(params, context) {
    return {
      success: true,
      llmContent: `处理结果: ${params.input}`,
      displayContent: `✅ 操作成功`,
    };
  }
});
```

## ✨ 核心特性

### 统一接口

所有工具（内置/MCP/自定义）使用相同的 `Tool` 接口。

### 类型安全

基于 Zod Schema 的端到端类型推断。

### 简洁 API

无需复杂继承，直接调用 `createTool`。

## 📖 更多资源

- **[智能工具](./smart-tools.md)** - LLM 驱动的高级工具
- **[Git 工具](./git-tools.md)** - Git 集成工具
- **[源码实现](../../src/tools/)** - 工具系统源代码
