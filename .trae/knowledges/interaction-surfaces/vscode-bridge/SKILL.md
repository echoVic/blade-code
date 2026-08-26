---
name: knowledge-interaction-surfaces-vscode-bridge
description: >
  覆盖 Blade VS Code 扩展的激活、WebSocket RPC、端口发现、编辑器/选区/诊断/Diff
  操作和扩展打包。进入时机：修改 IDE 桥协议、`/ide` 连接、状态栏、端口文件、VS Code
  命令或 VSIX 构建。 不包含：ACP 标准宿主集成（见 ../acp-host-integration/）、LSP
  Session 智能（见 ../../extension-ecosystem/lsp-code-intelligence/）。关键词：
  blade-vscode, BLADE_IDE_PORT, ide-port, WebSocketServer, openFile, openDiff,
  getDiagnostics, /ide。
---

## Module Structure

VS Code 扩展是独立于 ACP 的轻量编辑器桥：扩展进程启动 WebSocket server，CLI 通过环境
变量或端口文件发现它，RPC 直接调用 VS Code API。

### Directory Layout
- `packages/vscode/src/extension.ts` — 扩展激活、WebSocket 生命周期与全部 RPC handler
- `packages/vscode/package.json` — 激活事件、命令、设置、构建和打包入口
- `packages/vscode/README.md` — 当前公开 RPC 和安装方式
- `packages/vscode/TODO.md` — 已知稳定性缺口与后续能力边界
- `packages/cli/src/slash-commands/ide.ts` — CLI 端口发现、连接探测和安装提示
- `packages/cli/src/ide/` — IDE 环境检测与扩展安装命令

### Key Entry Points
- `activate()` in `packages/vscode/src/extension.ts` — 注册 start/stop/status 并按配置自动启动
- `startServer()` in `packages/vscode/src/extension.ts` — 建立 WebSocket、写端口文件和终端环境配置
- `handleMessage()` in `packages/vscode/src/extension.ts` — RPC method 分派
- `handleConnect()` in `packages/cli/src/slash-commands/ide.ts` — CLI 侧发现并探测扩展端口

## Gotchas
- VS Code 桥不是 ACP：它使用自定义 WebSocket `{id, method, params}` 协议，不能把 ACP Session 方法或能力协商假设套到该连接 (`packages/vscode/src/extension.ts`, `packages/cli/src/acp/index.ts`)
- `/ide connect` 只建立一次 WebSocket 探测后立即关闭，却把模块级状态记为 connected；该状态不是持久连接健康度，也不会驱动后续 RPC (`packages/cli/src/slash-commands/ide.ts`)
- 当前 CLI 只实现端口发现和连接探测，仓库中没有消费 `openFile`、`openDiff`、selection 或 diagnostics RPC 的长连接客户端；扩展公开能力不能等同于 Agent 已接入能力 (`packages/cli/src/slash-commands/ide.ts`, `packages/vscode/src/extension.ts`)
- 端口发现先读 `BLADE_IDE_PORT`，再读单一 `~/.blade/ide-port`；多窗口会覆盖同一文件，CLI 也不会按 workspace 选择实例 (`packages/cli/src/slash-commands/ide.ts`, `packages/vscode/src/extension.ts`, `packages/vscode/TODO.md`)
- WebSocket server 未配置 host、认证或 origin 校验，消息参数使用 `any` 且无 schema；在扩大功能或网络暴露前必须先补协议校验与访问边界 (`packages/vscode/src/extension.ts`, `packages/vscode/TODO.md`)
- `openFile.options.line` 是 1-based 并在调用 VS Code API 前减一，而 selection/diagnostic 返回值是 VS Code 原生 0-based；调用方不能混用坐标系 (`packages/vscode/src/extension.ts`)
- `setTerminalEnv()` 更新的是 Workspace 级集成终端配置且异步 Promise 未等待，只影响之后创建的终端；当前终端仍依赖扩展进程环境或端口文件 (`packages/vscode/src/extension.ts`)
- `stopServer()` 删除全局端口文件但不验证其中 pid/port 是否仍属于当前窗口；这与单文件多窗口限制是同一个生命周期风险 (`packages/vscode/src/extension.ts`, `packages/vscode/TODO.md`)

## Architecture
- 扩展在 `onStartupFinished` 激活，状态栏同时作为状态展示和 `blade-code.status` 命令入口；`autoStart` 默认开启 (`packages/vscode/package.json`, `packages/vscode/src/extension.ts`)
- 单个扩展实例维护一个 WebSocketServer 和 client Set，每条请求独立响应 `{id,result}` 或 `{id,error}`；JSON 解析失败的响应使用 `id: null` (`packages/vscode/src/extension.ts`)
- RPC 只提供编辑器控制与观察：打开文件、列出 tab、读取选区/工作区/诊断、打开已有文件 diff 和显示通知，不拥有 Agent 或 Session 生命周期 (`packages/vscode/src/extension.ts`, `packages/vscode/README.md`)
- 扩展端把实际端口、进程 ID、启动时间和 workspaceFolders 写入 JSON 端口文件；CLI 目前只消费 port 和首个 workspace 展示 (`packages/vscode/src/extension.ts`, `packages/cli/src/slash-commands/ide.ts`)

## Decisions
- 扩展以 esbuild 打包为 Node CommonJS，并将 `vscode` 标为 external；VSIX 构建不复用 CLI/Vite bundle (`packages/vscode/package.json`, `packages/vscode/tsconfig.json`)
- 该桥保留为基础 RPC 原型，聊天、事件订阅、编辑应用、终端与协议版本化仍明确列在后续计划中；新增能力不应假设这些基础设施已经存在 (`packages/vscode/TODO.md`)

## Patterns
- start/stop/status 共享模块级 server 状态，重复 start 只提示当前端口，stop 会关闭全部 client、server、环境变量和端口文件 (`packages/vscode/src/extension.ts`)
- 编辑器数据统一返回文件系统路径而非 URI 字符串，diff 输入也要求两个本地路径；远程工作区支持需要重新定义该契约 (`packages/vscode/src/extension.ts`)
- IDE 检测与安装走 `code`、`code-insiders`、`cursor` CLI，不通过扩展 WebSocket；命令不存在时按未安装处理 (`packages/cli/src/ide/detectIde.ts`, `packages/cli/src/ide/ideInstaller.ts`)

## Dependencies
- 扩展运行依赖 VS Code Extension API 与 `ws`；开发和打包依赖 esbuild、TypeScript 与 `@vscode/vsce` (`packages/vscode/package.json`)
