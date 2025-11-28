# Ripgrep Vendor Directory

此目录用于存放各平台的 ripgrep 二进制文件。

## 目录结构

```text
vendor/ripgrep/
├── darwin-arm64/rg      # macOS Apple Silicon
├── darwin-x64/rg        # macOS Intel
├── linux-arm64/rg       # Linux ARM64
├── linux-x64/rg         # Linux x64
└── win32-x64/rg.exe     # Windows x64
```

## 快速开始

### 自动下载（推荐）

```bash
npm run vendor:ripgrep
```

### 手动下载

1. 访问 [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases)
2. 下载对应平台的二进制文件（推荐 v14.1.0+）
3. 解压并放入对应目录
4. 设置执行权限（Unix 系统）:

   ```bash
   chmod +x vendor/ripgrep/*/rg
   ```

### 清理

```bash
npm run vendor:ripgrep:clean
```

## 注意事项

- 这些文件是**可选的**
- Grep 工具会自动降级到其他搜索方案
- 包含这些文件会增加 npm 包体积 ~40-50 MB
- 这些文件已添加到 `.gitignore`

## 更多信息

详细文档请参考: [docs/development/implementation/grep-tool.md](../../docs/development/implementation/grep-tool.md)
