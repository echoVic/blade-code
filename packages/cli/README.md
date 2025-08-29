# @blade-ai/cli

Blade AI 命令行界面包

## 📦 包概述

`@blade-ai/cli` 是 Blade AI 的命令行界面实现，提供：
- CLI命令解析
- 终端UI组件
- 用户交互界面
- 命令行工具集成

## 🚀 使用

```bash
npm install -g @blade-ai/cli
blade chat "你好"
```

## 📚 命令参考

### chat
智能对话命令

```bash
blade chat "问题"
blade chat -i  # 交互式模式
blade chat --stream  # 流式输出
```

### tools
工具管理命令

```bash
blade tools list  # 查看工具列表
blade tools call <tool>  # 调用工具
```

## 🏗️ 开发

### 构建
```bash
npm run build
```

### 开发模式
```bash
npm run dev
```

## 📄 许可证

MIT