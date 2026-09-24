# Ripgrep Vendor Directory

此目录用于存放各平台的 ripgrep 二进制文件。

## 许可证

ripgrep 由 [BurntSushi](https://github.com/BurntSushi) 开发，采用 **Unlicense/MIT 双许可证**。

- 项目地址: https://github.com/BurntSushi/ripgrep
- 许可证: [Unlicense](https://github.com/BurntSushi/ripgrep/blob/master/UNLICENSE) 或 [MIT](https://github.com/BurntSushi/ripgrep/blob/master/LICENSE-MIT)

本目录中的二进制文件直接从 ripgrep 官方 GitHub Releases 下载，未做任何修改。

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
# 在 packages/cli 目录执行；省略版本号时使用脚本内置的默认版本
node scripts/download-ripgrep.js [版本号]
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
rm -rf vendor/ripgrep/*/
```

## 注意事项

- `npm pack` / `npm publish` 会经 `prepack` 自动下载并校验这些文件，随 npm 包发布（解压后约 21 MB）
- 二进制不提交到 git（见 `.gitignore`）；`.npmignore` 让 npm 打包时不套用 `.gitignore`
- Grep 工具优先使用系统 rg，其次是这里的内置版本，都不可用时降级到其他搜索方案
