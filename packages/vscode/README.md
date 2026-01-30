# Blade Code VS Code Extension

VS Code 扩展，为 Blade Code CLI 提供 IDE 集成功能。

## 功能

- **自动启动 WebSocket 服务器** - 插件激活时自动启动
- **文件操作** - 在编辑器中打开文件、跳转到指定行
- **编辑器状态** - 获取打开的文件列表、当前选中的代码
- **诊断信息** - 获取 VS Code 的错误和警告信息
- **Diff 视图** - 打开文件对比视图

## 安装

### 从 Marketplace 安装

1. 打开 VS Code
2. 按 `Ctrl+Shift+X` 打开扩展面板
3. 搜索 "Blade Code"
4. 点击安装

### 从 VSIX 安装

```bash
code --install-extension blade-code-0.0.1.vsix
```

### 开发模式

```bash
cd vscode-extension
pnpm install
pnpm run compile
# 在 VS Code 中按 F5 启动调试
```

## 使用

1. 安装并启用插件
2. 插件会自动启动 WebSocket 服务器
3. 在 VS Code 终端中运行 `blade`
4. CLI 会自动检测并连接到插件

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `bladeCode.port` | `0` | WebSocket 端口（0 = 自动选择） |
| `bladeCode.autoStart` | `true` | 是否自动启动服务器 |

## API

WebSocket 支持以下方法：

| 方法 | 参数 | 说明 |
|------|------|------|
| `openFile` | `{ filePath, options? }` | 打开文件 |
| `getOpenEditors` | - | 获取打开的编辑器列表 |
| `getCurrentSelection` | - | 获取当前选中的文本 |
| `getWorkspaceFolders` | - | 获取工作区文件夹 |
| `getDiagnostics` | `{ uri? }` | 获取诊断信息 |
| `openDiff` | `{ originalPath, modifiedPath, title? }` | 打开 diff 视图 |
| `showMessage` | `{ type, message }` | 显示消息 |

## 消息格式

请求：
```json
{
  "id": 1,
  "method": "openFile",
  "params": {
    "filePath": "/path/to/file.ts",
    "options": { "line": 10 }
  }
}
```

响应：
```json
{
  "id": 1,
  "result": {
    "success": true,
    "filePath": "/path/to/file.ts"
  }
}
```

错误响应：
```json
{
  "id": 1,
  "error": {
    "message": "File not found"
  }
}
```

## 开发

```bash
# 安装依赖
pnpm install

# 编译
pnpm run compile

# 监听模式
pnpm run watch

# 打包
pnpm run package
```

## License

MIT
