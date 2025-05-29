# Agent CLI

一个功能强大的命令行工具，使用 TypeScript 开发。

## 安装

```bash
# 全局安装
npm install -g agent-cli

# 或者使用 pnpm
pnpm add -g agent-cli
```

## 开发

```bash
# 克隆仓库
git clone <仓库地址>
cd agent-cli

# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm dev

# 构建
pnpm build

# 本地运行
pnpm start
```

## 命令

### init

初始化一个新项目。

```bash
agent init [项目名称] -t [模板]
```

选项:
- `-t, --template`: 指定项目模板 (react, vue, node)

## 许可证

ISC 