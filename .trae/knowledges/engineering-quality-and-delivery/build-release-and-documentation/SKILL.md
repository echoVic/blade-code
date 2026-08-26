---
name: knowledge-engineering-quality-and-delivery-build-release-and-documentation
description: >
  覆盖 Bun/Vite/VS Code 构建、npm 包边界、版本与 tag 发布、GitHub Actions、vendor 资产、
  双语用户文档和 changelog 生成链。
  Navigate when: 修改构建输出、依赖分类、包内容、版本号、发布脚本/workflow、Docsify
  导航、双语文档或发布后验证。
  Excludes: 测试矩阵语义（见 ../real-api-qualification-and-e2e/）；
  性能、安全和快照阈值（见 ../performance-security-and-snapshot-gates/）。
  Keywords: Bun.build, Vite, dist, package files, release.js, publish.yml, npm OIDC,
  Trusted Publishing, tag, CHANGELOG.md, CHANGELOG.zh.md, Docsify, ripgrep, Playwright.
---

## Module Structure

交付链以 `packages/cli/package.json` 为 npm 权威版本，先把 Node CLI 与 Vite Web 构建到一个发布目录，再由版本 tag 触发 OIDC npm 发布；文档站从 Git 可见双语源和部署时生成的 changelog 组成。

### Directory Layout
- `package.json` — 私有 monorepo 工作区和 CLI/VS Code 聚合命令
- `packages/cli/package.json` — `blade-code` 发布版本、bin、files、依赖和 prepack
- `packages/cli/scripts/build.ts`、`packages/cli/web/vite.config.ts` — 后端 ESM 与 Web 静态资源构建
- `packages/vscode/package.json` — 独立 VS Code 扩展构建，不进入 `blade-code` npm 文件清单
- `packages/cli/scripts/release.js`、`packages/cli/release.config.js` — 本地版本、changelog、tag 与 push 编排
- `scripts/release.sh`、`scripts/setup-auto-release.sh`、`scripts/get-npm-token.sh` — 仓库遗留发布辅助脚本
- `.github/workflows/ci.yml`、`.github/workflows/publish.yml`、`.github/workflows/docs.yml` — CI、npm/GitHub Release 与 Pages
- `CHANGELOG.md`、`CHANGELOG.zh.md`、`docs/` — 英文权威 changelog、中文同步记录和双语 Docsify 源
- `vendor/ripgrep/`、`packages/cli/vendor/ripgrep/` — 可选二进制的忽略目录与 Git 可见说明

### Key Entry Points
- `packages/cli/scripts/build.ts` — 清空 `dist`、externalize 运行时依赖、构建 CLI 并调用 Vite
- `packages/cli/scripts/release.js` — 本地版本递增、changelog、构建、提交、tag 和 push
- `packages/cli/release.config.js` — 决定本地发布脚本实际跳过或执行哪些步骤
- `.github/workflows/publish.yml` — tag 或手动 dispatch 的幂等 npm/GitHub Release
- `.github/workflows/docs.yml` — changelog 复制和 GitHub Pages 部署
- `AGENTS.md` — 当前仓库要求的独立 patch、双语 changelog 和发布前验证契约

## Branching Table

| 维度 | 分支 A | 分支 B |
|------|--------|--------|
| 根构建目标 | `build:cli` 构建可发布 CLI 与嵌入 Web | `build:vscode` 独立输出 VS Code extension |
| CLI 构建内容 | Bun 将 `src/blade.tsx` 打成 Node ESM chunks，依赖保持 external | Vite 将 Web 打到 `packages/cli/dist/web` 并按 React/xterm/radix/session-events 分块 |
| 开发与发布 | 开发从源码 watch 启动 | npm 只暴露 `dist/blade.js`，并依赖 `prepack` 重新构建 |
| 本地发布与远端发布 | `release.js` 递增版本、生成英文 changelog、提交并推 tag | `publish.yml` 校验 tag=包版本后构建并通过 OIDC 发布 |
| workflow 入口 | tag push 检出触发 tag | 手动 dispatch 检出调用者指定的既有 tag |
| npm 状态 | 版本不存在时执行 `npm publish --access public` | 版本已存在时跳过 publish，继续确保 GitHub Release |
| 文档 changelog | 根 `CHANGELOG.zh.md`/`CHANGELOG.md` 是维护源 | 部署时复制到被忽略的 `docs/changelog.md`/`docs/en/changelog.md` |
| 浏览器与搜索资产 | Playwright 包和可选 `@vscode/ripgrep` 随 npm 依赖解析 | Chromium 与 vendored ripgrep 二进制都不是普通源码 checkout 自动具备的资产 |

## Affected Scope
- `packages/cli/src/blade.tsx` — Bun 后端 bundle 的唯一入口
- `packages/cli/web/src/` — Vite 构建并嵌入 CLI `dist/web` 的前端
- `packages/vscode/src/` — 根构建的第二目标，使用独立 esbuild 配置
- `packages/cli/scripts/build.ts`、`packages/cli/web/vite.config.ts` — npm bin 与 Web 静态资源制品的生成入口
- `packages/cli/package.json` — npm 版本、files 白名单、bin 和运行时依赖
- `packages/cli/release.config.js`、`packages/cli/scripts/release.js` — 本地 release 行为与远端 tag 发布的交接点
- `.github/workflows/` — CI、tag 发布与 Pages 的远端执行边界
- `CHANGELOG.md`、`CHANGELOG.zh.md` — 发布记录和文档站生成源
- `docs/`、`docs/en/` — 中文默认与英文镜像的用户/参考/测试文档
- `vendor/ripgrep/`、`packages/cli/vendor/ripgrep/` — 可选平台搜索二进制的准备位置

## Gotchas
- npm 发布版本只来自 `packages/cli/package.json`；根 `package.json` 的 `0.1.x` 是私有 monorepo 版本，不能用来创建 `blade-code` tag (`package.json`, `packages/cli/package.json`, `.github/workflows/publish.yml`)
- `release.config.js` 当前关闭 `runTests`、`checkCodeQuality` 和 `checkSecurity`，所以 `release:patch` 即使成功也没有证明候选通过本地或生产资格 (`packages/cli/release.config.js`, `packages/cli/scripts/release.js`)
- 本地 release 脚本只按配置生成根 `CHANGELOG.md`，不会同步 `CHANGELOG.zh.md`；仓库规则要求两份 changelog 在版本提交前人工保持同 heading 和语义 (`packages/cli/release.config.js`, `packages/cli/scripts/release.js`, `AGENTS.md`)
- `publish.yml` 只校验 tag/包版本、构建和发布，不运行测试；必须先在精确候选 SHA 上完成资格，再创建 tag (`.github/workflows/publish.yml`, `docs/testing/qualification.md`)
- `docs/changelog.md` 与 `docs/en/changelog.md` 被 Git 忽略并在 Pages workflow 中重建，直接编辑会丢失且不会成为权威源 (`.gitignore`, `.github/workflows/docs.yml`, `AGENTS.md`)
- 两个 ripgrep vendor 目录只跟踪 `.gitignore` 和 README，二进制被忽略；`packages/cli/package.json` 的 vendor files 白名单不保证 fresh checkout 已含平台二进制 (`packages/cli/package.json`, `packages/cli/vendor/ripgrep/.gitignore`, `vendor/ripgrep/.gitignore`)
- `download-ripgrep.js` 的两个 macOS 条目名称与 `x86_64`/`aarch64`、`darwin-x64`/`darwin-arm64` 映射相反，重新生成 vendor 资产前必须先核对平台映射 (`packages/cli/scripts/download-ripgrep.js`)
- `scripts/setup-auto-release.sh` 与 `scripts/get-npm-token.sh` 仍描述 `NPM_TOKEN`/Release Please，且后者会显示并复制本地 token；当前权威发布已迁移到 OIDC，不应运行这些遗留助手 (`scripts/setup-auto-release.sh`, `scripts/get-npm-token.sh`, `.github/workflows/publish.yml`, `git:45fe4348`)
- `VersionChecker` 从 npm CDN 请求包根 `CHANGELOG.md`，但 CLI `files` 白名单没有显式列出或复制该文件；改包清单或 release layout 时必须用 `npm pack` 核验更新说明确实可取 (`packages/cli/src/services/VersionChecker.ts`, `packages/cli/package.json`)

## Architecture
- 后端 build 将 dependencies、optionalDependencies 与 peerDependencies 全部 externalize，运行时完整性取决于 npm 正确安装依赖；Web 则由 Vite bundle 到同一个 `dist` 树 (`packages/cli/scripts/build.ts`, `packages/cli/web/vite.config.ts`)
- 根 `bun run build` 先构建 CLI（其中包含 Web）再构建 VS Code extension；`blade-code` npm `files` 不包含 VS Code 产物 (`package.json`, `packages/cli/package.json`, `packages/vscode/package.json`)
- tag workflow 使用 `contents: write` 与 `id-token: write`，升级 npm 后走 Trusted Publishing，并对已存在 npm 版本和 GitHub Release执行幂等检查 (`.github/workflows/publish.yml`)
- Docs workflow 只在 main 的 docs/changelog 变更或手动触发时部署，先将中文 changelog 放到默认根、英文 changelog 放到 `/en/` (`.github/workflows/docs.yml`)

## Decisions
- npm 长期 token 已被 OIDC Trusted Publishing 取代，以减少 secret 失效面并产生 registry provenance；旧 token 辅助脚本不再是发布架构的一部分 (`.github/workflows/publish.yml`, `git:45fe4348`)
- Playwright 是固定版本运行时依赖，但 Chromium 采用显式安装而非 npm install 自动下载，保持普通 CLI 安装轻量且让浏览器可用性在 preflight 中可诊断 (`packages/cli/package.json`, `docs/getting-started/installation.md`)
- 文档采用中文默认根与英文 `/en/` 镜像，未翻译内容允许英文站回退中文；行为契约变更仍应优先同步两种语言的对应页面 (`docs/README.md`, `docs/en/README.md`, `docs/_sidebar.md`, `docs/en/_sidebar.md`)

## Patterns
- 近期 release commit 固定同改 CLI package 版本和中英文 changelog；功能实现、资格修复与 release metadata 通常分开提交，便于证明候选 SHA 到 tag HEAD 的差异 (`packages/cli/package.json`, `CHANGELOG.md`, `CHANGELOG.zh.md`, `git:1ce74b03`)
- 用户可见功能先更新 `docs/`/`docs/en/` 源，再由 Pages workflow 生成 changelog 页面；不要把部署产物反向当作编辑源 (`.github/workflows/docs.yml`, `AGENTS.md`)
- 每个独立 feature/fix 使用单独 patch 版本，避免多个未经独立资格的行为共享一个 npm 发布边界 (`AGENTS.md`)

## Dependencies
- CI 与发布统一 Bun `1.3.11`、Node `22.x`，npm Trusted Publishing 还在 workflow 内升级到支持 OIDC 的新 npm；更换版本时要同时检查 root metadata、CI 和 publish workflow (`package.json`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`)

## Branching Behavior
- `packages/cli/scripts/build.ts` 找到 Web Vite 配置时构建 Web，找不到时只打印跳过并仍完成后端构建；发布检查若要求 Web，不能只依赖 build 的零退出 (`packages/cli/scripts/build.ts`)
- 本地 `release.js` 在 npm 发布关闭时仍会 commit、tag 并 push branch/tags，真正 npm 发布随后由 tag workflow 接管 (`packages/cli/release.config.js`, `packages/cli/scripts/release.js`, `.github/workflows/publish.yml`)
- tag workflow 在 npm 版本已存在时跳过重复 publish，在 GitHub Release 已存在时保留原对象，因此支持同一 tag 的手动幂等恢复 (`.github/workflows/publish.yml`)
- Pages workflow 的中英文映射是 `CHANGELOG.zh.md -> docs/changelog.md`、`CHANGELOG.md -> docs/en/changelog.md`；反向复制会让站点语言错位 (`.github/workflows/docs.yml`)
- npm 包安装只提供 Playwright JavaScript 运行库，`blade browser install` 才下载 Chromium；普通 CLI、WebFetch 与 WebSearch 路径不应因浏览器缺失而失败 (`packages/cli/package.json`, `docs/getting-started/installation.md`)
