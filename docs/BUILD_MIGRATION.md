# 构建方案迁移：从 tsup 到 tsc --build + esbuild

## 概述

本文档描述了 Blade 项目构建方案的迁移过程，从使用 `tsup` 改为使用 `tsc --build` 进行开发阶段编译，使用 `esbuild` 进行打包阶段。

## 迁移原因

1. **更好的控制**：`tsc --build` 提供了对 TypeScript 项目引用的更好支持，适合 monorepo 结构。
2. **更快的打包**：`esbuild` 比 `tsup` 更快，特别是在打包大型项目时。
3. **更灵活的配置**：分离开发阶段和打包阶段的构建流程，使每个阶段都可以使用最适合的工具。

## 新的构建方案

### 1. 开发阶段：tsc --build

在开发阶段，各个 package 使用 `tsc --build` 编译 TypeScript 代码。

**优点：**
- 支持项目引用，可以自动处理包之间的依赖关系
- 生成类型定义文件（.d.ts）
- 更好的错误提示和类型检查
- 与 TypeScript 编译器紧密集成

**配置：**
- 根目录 `tsconfig.json` 配置项目引用
- 各个 package 的 `tsconfig.json` 继承根目录配置并设置 `composite: true`

### 2. 打包阶段：esbuild

在打包阶段，使用 `esbuild` 为每个子包单独打包成可执行文件。

**优点：**
- 极快的打包速度
- 生成优化的 JavaScript 代码
- 支持代码分割和摇树优化
- 每个子包单独打包，便于单独发布和维护

**配置：**
- 使用 `scripts/build-bundle.js` 脚本进行打包
- 支持单独打包 CLI 或 Core 包
- 自动复制类型定义文件到各自的 bundle 目录
- 每个子包的 bundle 文件位于各自的 bundle 目录中

### 3. 发布：每个子包单独发布，包含各自的打包文件

**优点：**
- 每个子包可以独立发布和版本控制
- 用户可以选择性地安装所需的包
- 更灵活的依赖管理
- 减少不必要的依赖

## 使用方法

### 开发阶段

```bash
# 编译所有包
pnpm build

# 编译特定包
cd packages/core && pnpm build
cd packages/cli && pnpm build

# 监听模式编译
pnpm dev
```

### 打包阶段

```bash
# 打包所有包
pnpm build:bundle

# 只打包 Core 包
pnpm build:bundle:core

# 只打包 CLI 包
pnpm build:bundle:cli

# 在子包目录中打包
cd packages/core && pnpm build:bundle
cd packages/cli && pnpm build:bundle
```

### 发布阶段

```bash
# 发布 Core 包
cd packages/core && pnpm publish

# 发布 CLI 包
cd packages/cli && pnpm publish
```

## 文件结构

```
blade-ai/
├── package.json
├── tsconfig.json
├── scripts/
│   └── build-bundle.js
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── dist/
│   │   │   ├── index.js
│   │   │   └── index.d.ts
│   │   └── bundle/
│   │       ├── index.js
│   │       └── types/
│   │           └── index.d.ts
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       ├── dist/
│       │   ├── cli.js
│       │   └── cli.d.ts
│       └── bundle/
│           ├── cli.js
│           └── types/
│               └── cli.d.ts
└── bin/
    └── blade.js
```

## 配置详情

### 根目录 package.json

```json
{
  "scripts": {
    "dev": "tsc --build --watch",
    "build": "pnpm -r build",
    "build:bundle": "node scripts/build-bundle.js --all",
    "build:bundle:core": "node scripts/build-bundle.js core",
    "build:bundle:cli": "node scripts/build-bundle.js cli"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "typescript": "^5.9.2"
  }
}
```

### packages/core/package.json

```json
{
  "main": "bundle/index.js",
  "types": "bundle/types/index.d.ts",
  "typesVersions": {
    "*": {
      "types": ["bundle/types/*"],
      "bundle": ["bundle/*"]
    }
  },
  "scripts": {
    "build": "tsc --build",
    "build:types": "tsc --declaration --emitDeclarationOnly --outDir dist",
    "build:bundle": "node ../../scripts/build-bundle.js core"
  },
  "files": [
    "dist",
    "bundle"
  ]
}
```

### packages/cli/package.json

```json
{
  "bin": {
    "blade": "bundle/cli.js"
  },
  "scripts": {
    "build": "tsc --build",
    "build:bundle": "node ../../scripts/build-bundle.js cli"
  },
  "files": [
    "dist",
    "bundle"
  ]
}
```

### bin/blade.js

```javascript
#!/usr/bin/env node

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// 优先使用子包的 bundle，如果不存在则使用子包的 dist
const bundlePath = join(rootDir, 'packages/cli/bundle/cli.js');
const distPath = join(rootDir, 'packages/cli/dist/cli.js');

let cliPath;
if (existsSync(bundlePath)) {
  cliPath = bundlePath;
} else if (existsSync(distPath)) {
  cliPath = distPath;
} else {
  console.error('Error: Neither bundle nor dist files found. Please run "pnpm build" first.');
  process.exit(1);
}

import(cliPath);
```

## 注意事项

1. **TypeScript 配置**：确保 `tsconfig.json` 中设置了 `composite: true` 和正确的项目引用。
2. **依赖管理**：在打包阶段，外部依赖需要正确配置，以避免将它们打包进 bundle。
3. **类型定义**：确保在打包前生成类型定义文件，以便其他包可以使用。
4. **入口文件**：`bin/blade.js` 会自动选择使用子包的 bundle 或 dist 文件，优先使用 bundle。
5. **包发布**：每个子包单独发布，确保在发布前运行 `pnpm build:bundle` 生成打包文件。
6. **开发依赖**：确保在打包时正确处理开发依赖，避免将它们打包进最终文件。

## 未来改进

1. **增量构建**：可以考虑使用 `tsc --build --incremental` 来提高开发阶段的构建速度。
2. **并行构建**：可以使用 `tsc --build --verbose` 来查看构建过程，并优化并行构建。
3. **打包优化**：可以进一步优化 esbuild 配置，例如代码分割、摇树优化等。
4. **CI/CD 集成**：可以将新的构建流程集成到 CI/CD 流程中，自动化构建和发布。