# Blade Code 测试手段与生产准出

Blade Code 将确定性回归与付费模型验证分成两道门禁。两道门禁都必须通过，才可以把一个功能 patch 标记为生产就绪。

## 本地门禁

在仓库根目录执行：

```bash
bun run qualify:local
```

命令会按固定顺序执行：

1. `type-check`
2. `format:check`
3. `lint`
4. 单元测试
5. CLI 集成测试
6. headless/runtime 核心回归
7. E2E、snapshot 和性能回归
8. 安全测试
9. Web 测试和 Web 类型检查
10. 当前源码构建

每一步都在独立子进程中执行。第一步非零退出会立即停止，后续步骤不会被计为通过。该门禁不访问付费模型，也不依赖 `~/.blade/config.json`。

## 真实 API 门禁

真实 API 门禁必须使用当前源码刚构建的 `packages/cli/dist/blade.js`。执行：

```bash
DEEPSEEK_API_KEY="..." \
DEEPSEEK_BASE_URL=https://api.deepseek.com \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bun run qualify:production
```

`qualify:production` 在启动任何测试子进程前会 fail-closed 校验：

- `DEEPSEEK_API_KEY` 必须存在；
- `DEEPSEEK_MODELS` 必须同时包含 `deepseek-v4-flash` 和 `deepseek-v4-pro`；
- 未提供 `DEEPSEEK_BASE_URL` 时使用 `https://api.deepseek.com`；
- `DEEPSEEK_MODEL` 默认选择列表中的第一个模型，供单模型轨迹使用；
- 只要存在任一 provider 的显式 API key，环境变量集合就成为完整 allowlist，测试不会再合并 `~/.blade/config.json` 中的个人模型；
- API key 只通过进程环境传递，不写入配置文件、源码、日志或快照。

真实 API 项目覆盖两种模型的生产 CLI 轨迹，包括：

- 单文件缺陷修复：读取、编辑、运行测试并确认 diff 范围；
- 多文件 API 迁移：修改所有生产调用方并运行类型检查和测试；
- 计划模式恢复：跨两个 CLI 进程恢复会话并完成修改；
- 失败恢复：先重现测试失败，再修改，最后验证通过；
- 超时恢复：回收完整进程树后继续工具循环，并确认没有后代进程遗留；
- 输出协议、工具调用、错误事件和 key 泄漏检查。

仅收到模型文本或 HTTP 200 不算通过。每条轨迹都必须证明文件内容、`git diff --name-only`、测试/类型检查退出码、结构化事件和进程退出状态。

## 准出证据

每个独立 patch 至少保留以下证据：

- `bun run qualify:local` 的完整命令和退出码；
- `bun run qualify:production` 的完整命令、使用的模型集合和退出码；
- 真实 API 运行中不得记录原始密钥；
- 失败时记录首个失败门禁和可复现命令，不得用跳过测试替代通过；
- 代码、文档和测试改动通过 `git diff --check`。

真实 API 门禁会产生费用，因此不会被 `test:all` 或普通 CI 单元门禁隐式触发；发布候选、跨 provider 改动和 Agent runtime 核心改动必须显式运行。
