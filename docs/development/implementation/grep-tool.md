# Grep 工具实现文档

## 目录

- [概述](#概述)
- [架构设计](#架构设计)
- [降级策略](#降级策略)
- [使用指南](#使用指南)
- [部署配置](#部署配置)
- [性能优化](#性能优化)
- [故障排查](#故障排查)

---

## 概述

Blade 的 Grep 工具是一个具有**多级智能降级策略**的生产级搜索工具，结合了 neovate-code 的内置 ripgrep 方案和 gemini-cli 的优雅降级策略，确保在任何环境下都能提供最佳的搜索体验。

### 核心特性

- ✅ **零必需依赖**: 所有搜索引擎都是可选的
- ✅ **100% 可用性**: JavaScript fallback 确保任何环境都能工作
- ✅ **极致性能**: 优先使用最快的 ripgrep
- ✅ **智能降级**: 自动选择最佳可用策略
- ✅ **跨平台**: 支持 macOS、Linux、Windows (x64/ARM64)

### 版本信息

- **当前版本**: 3.0.0
- **上次更新**: 2025-11-28
- **兼容性**: 完全向后兼容 2.x API

---

## 架构设计

### 策略枚举

```typescript
enum SearchStrategy {
  RIPGREP = 'ripgrep',      // 最快，需要 ripgrep 可执行文件
  GIT_GREP = 'git-grep',    // 快，仅在 Git 仓库中可用
  SYSTEM_GREP = 'system-grep', // 中等，几乎所有系统可用
  FALLBACK = 'fallback',    // 慢，100% 可用
}
```

### 核心函数结构

```typescript
// 1. 辅助函数
getPlatformRipgrepPath()  // 获取平台特定的 vendor ripgrep 路径
getRipgrepPath()          // 智能查找 ripgrep (系统 > vendor > @vscode/ripgrep)
isGitRepository()         // 检查是否在 Git 仓库中
isSystemGrepAvailable()   // 检查系统 grep 是否可用

// 2. 执行函数
executeRipgrep()          // 执行 ripgrep 搜索
executeGitGrep()          // 执行 git grep (降级策略 1)
executeSystemGrep()       // 执行 system grep (降级策略 2)
executeFallbackGrep()     // 纯 JavaScript 实现 (降级策略 3)

// 3. 工具函数
buildRipgrepArgs()        // 构建 ripgrep 命令参数
parseGrepOutput()         // 解析输出为统一格式
formatDisplayMessage()    // 格式化显示消息

// 4. 主入口
execute()                 // 主执行函数，整合所有策略
```

### 数据结构

```typescript
// 搜索结果条目
interface GrepMatch {
  file_path: string;
  line_number?: number;
  content?: string;
  context_before?: string[];
  context_after?: string[];
  count?: number;
}

// 统一的搜索结果结构
interface SearchResult {
  matches: GrepMatch[];
  stderr?: string;
  exitCode: number;
}
```

---

## 降级策略

### 优先级顺序

```
┌─────────────────────────────────────┐
│  策略 1: Ripgrep (极致性能)         │
│  ├─ 系统 ripgrep (最快)             │
│  ├─ Vendor ripgrep (内置)           │
│  └─ @vscode/ripgrep (可选)          │
├─────────────────────────────────────┤
│  策略 2: Git Grep                   │
│  └─ 在 Git 仓库中使用               │
├─────────────────────────────────────┤
│  策略 3: System Grep                │
│  └─ 使用系统自带 grep               │
├─────────────────────────────────────┤
│  策略 4: JavaScript Fallback        │
│  └─ 纯 JS 实现，100% 可用           │
└─────────────────────────────────────┘
```

### Ripgrep 查找逻辑

```typescript
function getRipgrepPath(): string | null {
  // 1. 尝试系统安装的 ripgrep
  try {
    const cmd =
      process.platform === 'win32'
        ? 'where rg'
        : 'command -v rg 2>/dev/null || which rg 2>/dev/null';
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      .trim();
    if (out) return out;
  } catch {}

  // 2. 尝试内置的 vendor ripgrep
  const vendorRg = getPlatformRipgrepPath();
  if (vendorRg && existsSync(vendorRg)) return vendorRg;

  // 3. 尝试 @vscode/ripgrep (可选依赖)
  try {
    const vsRipgrep = require('@vscode/ripgrep');
    if (vsRipgrep?.rgPath) return vsRipgrep.rgPath;
  } catch {}

  return null;
}
```

### 执行流程

```typescript
async execute(params, context) {
  let result: SearchResult | null = null;
  let strategy = SearchStrategy.RIPGREP;

  // 策略 1: 尝试 ripgrep
  if (getRipgrepPath()) {
    try {
      result = await executeRipgrep(...);
    } catch {
      result = null; // 失败则继续降级
    }
  }

  // 策略 2: 降级到 git grep
  if (!result && await isGitRepository(path)) {
    try {
      result = await executeGitGrep(...);
      strategy = SearchStrategy.GIT_GREP;
    } catch {
      result = null;
    }
  }

  // 策略 3: 降级到系统 grep
  if (!result && isSystemGrepAvailable()) {
    try {
      result = await executeSystemGrep(...);
      strategy = SearchStrategy.SYSTEM_GREP;
    } catch {
      result = null;
    }
  }

  // 策略 4: 最终降级到 JavaScript
  if (!result) {
    result = await executeFallbackGrep(...);
    strategy = SearchStrategy.FALLBACK;
  }

  return {
    success: true,
    llmContent: result.matches,
    metadata: { strategy, ... }
  };
}
```

### 性能对比

基于 10,000 文件 / 100 MB 代码库测试：

| 策略 | 时间 | 相对速度 | 内存 | 可用性 |
|------|------|---------|------|--------|
| Ripgrep | 0.5s | 1x (基准) | 50 MB | 需要安装/内置 |
| Git Grep | 1.2s | 2.4x | 80 MB | Git 仓库 |
| System Grep | 3.5s | 7x | 100 MB | 几乎所有系统 |
| JavaScript | 12.0s | 24x | 200 MB | 100% 可用 |

---

## 使用指南

### 基本搜索

```typescript
// 搜索包含 "TODO" 的文件（默认模式）
await grepTool.execute({
  pattern: 'TODO',
}, context);

// 返回:
// [
//   { file_path: 'src/index.ts' },
//   { file_path: 'src/utils.ts' },
// ]
```

### 显示匹配行（带行号和上下文）

```typescript
await grepTool.execute({
  pattern: 'error',
  output_mode: 'content',
  '-n': true,  // 显示行号（默认）
  '-C': 3,     // 前后各 3 行上下文
}, context);
```

### 文件类型过滤

```typescript
// 使用 type 参数（推荐，更快）
await grepTool.execute({
  pattern: 'interface',
  type: 'ts',  // 只搜索 TypeScript 文件
}, context);

// 使用 glob 模式（支持复杂模式）
await grepTool.execute({
  pattern: 'import',
  glob: 'src/**/*.{ts,tsx}',
}, context);
```

### 正则表达式

```typescript
// 匹配函数定义
await grepTool.execute({
  pattern: 'function\\s+\\w+\\(',
  output_mode: 'content',
}, context);

// 忽略大小写
await grepTool.execute({
  pattern: 'ERROR',
  '-i': true,
}, context);
```

### 限制结果数量

```typescript
// 只返回前 20 个匹配
await grepTool.execute({
  pattern: 'console.log',
  head_limit: 20,
}, context);

// 分页：跳过前 10 个，返回接下来的 20 个
await grepTool.execute({
  pattern: 'console.log',
  offset: 10,
  head_limit: 20,
}, context);
```

### 多行匹配

```typescript
// 匹配跨多行的模式
await grepTool.execute({
  pattern: 'interface.*\\{[\\s\\S]*?\\}',
  multiline: true,
  output_mode: 'content',
}, context);
```

### 检查使用的策略

```typescript
const result = await grepTool.execute({
  pattern: 'test',
}, context);

console.log('使用的策略:', result.metadata.strategy);
// 可能的值: 'ripgrep', 'git-grep', 'system-grep', 'fallback'
```

---

## 部署配置

### Vendor Ripgrep 设置

#### 下载所有平台的 ripgrep

```bash
npm run vendor:ripgrep
```

这将下载以下平台的 ripgrep：
- macOS (Apple Silicon & Intel)
- Linux (x64 & ARM64)
- Windows (x64)

总大小: 约 40-50 MB

#### 手动下载

1. 访问 [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases)
2. 下载对应平台的二进制文件（推荐 v14.1.0+）
3. 放入 `vendor/ripgrep/` 对应目录：

```
vendor/ripgrep/
├── darwin-arm64/rg      # macOS Apple Silicon
├── darwin-x64/rg        # macOS Intel
├── linux-arm64/rg       # Linux ARM64
├── linux-x64/rg         # Linux x64
└── win32-x64/rg.exe     # Windows x64
```

4. 设置执行权限（Unix 系统）：
```bash
chmod +x vendor/ripgrep/*/rg
```

#### 清理 vendor 文件

```bash
npm run vendor:ripgrep:clean
```

### 部署策略

#### 选项 A: 包含 Vendor Ripgrep（完整支持）

```bash
# 下载所有平台的 ripgrep
npm run vendor:ripgrep

# 确保 package.json 的 files 字段包含 vendor
# "files": ["dist", "bin", "vendor", ...]

# 发布
npm publish
```

**优点**:
- 📦 用户安装即用，无需额外配置
- ⚡ 性能最优
- 🌍 支持所有平台

**缺点**:
- 📈 npm 包增加 ~40-50 MB

**适用场景**:
- 商业发行版
- 企业内网环境
- 追求开箱即用体验

#### 选项 B: 不包含 Vendor（最小体积）

```bash
# 不运行 vendor:ripgrep
# 从 package.json files 字段移除 vendor

# 发布
npm publish
```

**优点**:
- 📉 包体积最小
- 🚀 下载和安装更快

**缺点**:
- 需要用户自行安装 ripgrep 获得最佳性能

**适用场景**:
- 开源项目
- 开发工具
- 对包体积敏感的场景

### 依赖配置

```json
{
  "optionalDependencies": {
    "@vscode/ripgrep": "^1.17.0"
  },
  "dependencies": {
    "picomatch": "^4.0.3"  // 用于 glob 匹配
  }
}
```

### CI/CD 配置

```yaml
# .github/workflows/build.yml
steps:
  - name: Install ripgrep (optional, for best performance)
    run: |
      if [[ "$RUNNER_OS" == "Linux" ]]; then
        sudo apt-get install -y ripgrep
      elif [[ "$RUNNER_OS" == "macOS" ]]; then
        brew install ripgrep
      fi

  - name: Build
    run: npm run build

  - name: Test
    run: npm test
```

---

## 性能优化

### 1. 优先使用 type 而不是 glob

```typescript
// ✅ 推荐
await grepTool.execute({
  pattern: 'test',
  type: 'ts',  // ripgrep 内置支持，更快
}, context);

// ❌ 避免（除非需要复杂模式）
await grepTool.execute({
  pattern: 'test',
  glob: '*.ts',  // 需要额外的模式匹配
}, context);
```

### 2. 限制搜索范围

```typescript
// 指定搜索路径
await grepTool.execute({
  pattern: 'test',
  path: './src',  // 只搜索 src 目录
}, context);
```

### 3. 使用 head_limit

```typescript
// 只需要少量结果时
await grepTool.execute({
  pattern: 'test',
  head_limit: 10,  // 找到 10 个就停止
}, context);
```

### 4. 避免不必要的 multiline

```typescript
// ❌ 性能差
await grepTool.execute({
  pattern: 'simple',
  multiline: true,  // 不需要多行匹配时不要开启
}, context);

// ✅ 性能好
await grepTool.execute({
  pattern: 'simple',
  // multiline 默认为 false
}, context);
```

### 5. 确保 ripgrep 可用

```bash
# 开发环境：安装系统 ripgrep
# macOS
brew install ripgrep

# Linux
sudo apt-get install ripgrep

# Windows (chocolatey)
choco install ripgrep
```

---

## 故障排查

### 问题 1: 搜索很慢

**症状**: 搜索耗时很长

**诊断**:
```typescript
const result = await grepTool.execute({ pattern: 'test' }, context);
console.log('策略:', result.metadata.strategy);
```

**解决方案**:
- 如果显示 `'fallback'`，说明所有搜索引擎都不可用
- 安装系统 ripgrep: `brew install ripgrep` (macOS)
- 或运行 `npm run vendor:ripgrep` 下载内置 ripgrep

### 问题 2: ripgrep 未找到

**症状**:
```
⚠️ ripgrep 失败，尝试降级策略...
```

**解决方案**:

1. 检查系统 ripgrep:
```bash
which rg
# 或
where rg  # Windows
```

2. 检查 vendor ripgrep:
```bash
ls -lh vendor/ripgrep/*/rg*
```

3. 检查 @vscode/ripgrep:
```bash
node -e "console.log(require('@vscode/ripgrep').rgPath)"
```

### 问题 3: vendor ripgrep 权限错误

**症状**:
```
Permission denied
```

**解决方案**:
```bash
chmod +x vendor/ripgrep/*/rg
```

### 问题 4: 下载脚本失败

**症状**:
```bash
npm run vendor:ripgrep
# Error: ...
```

**解决方案**:

1. 检查网络连接
2. 确保有必要的工具:
   - `curl` 或 `wget`
   - `tar` (Unix)
   - `unzip` (Windows)
3. 手动下载（见部署配置章节）

### 问题 5: Git grep 失败

**症状**:
```
⚠️ git grep 失败，继续尝试其他策略...
```

**原因**: 不在 Git 仓库中，或 Git 未安装

**解决方案**: 无需处理，工具会自动降级到其他策略

### 问题 6: 特殊字符搜索失败

**症状**: 搜索包含特殊字符的内容时没有结果

**解决方案**: 正确转义特殊字符
```typescript
// ❌ 错误
pattern: '.'  // 会匹配任意字符

// ✅ 正确
pattern: '\\.'  // 只匹配点号
```

### 问题 7: Glob 模式不匹配

**症状**: 使用 glob 参数但没有匹配到预期的文件

**解决方案**: 确保 glob 模式正确
```typescript
// ❌ 错误
glob: 'src/*.ts'  // 不递归

// ✅ 正确
glob: 'src/**/*.ts'  // 递归匹配
```

---

## 附录

### 支持的文件类型

常用的 `type` 参数值：

- `js` - JavaScript
- `ts` - TypeScript
- `tsx` - TypeScript JSX
- `py` - Python
- `rust` - Rust
- `go` - Go
- `java` - Java
- `c` - C
- `cpp` - C++
- `md` - Markdown
- `json` - JSON
- `yaml` - YAML

完整列表: `rg --type-list`

### Glob 模式示例

```typescript
// 匹配所有 TypeScript 文件
glob: '**/*.ts'

// 匹配 src 目录下的 TypeScript 和 TSX
glob: 'src/**/*.{ts,tsx}'

// 排除测试文件
glob: '!(*.test|*.spec).ts'

// 匹配多个目录
glob: '{src,lib}/**/*.ts'
```

### 正则表达式常用模式

```typescript
// 函数定义
pattern: 'function\\s+\\w+\\('

// Email 地址
pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'

// URL
pattern: 'https?://[^\\s]+'

// TODO/FIXME 注释
pattern: '(TODO|FIXME|HACK):'

// import 语句
pattern: 'import.*from ["\'][^"\']+["\']'

// 十六进制颜色
pattern: '#[0-9a-fA-F]{6}'
```

### 相关链接

- [Ripgrep 用户指南](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)
- [Picomatch 文档](https://github.com/micromatch/picomatch)
- [正则表达式测试工具](https://regexr.com/)
- [Blade 项目文档](../../README.md)

---

**最后更新**: 2025-11-28
**维护者**: Blade 开发团队
