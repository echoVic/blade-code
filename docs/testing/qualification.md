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
- 瞬时 API 恢复：本地代理让首个模型请求返回 `503`，随后转发真实 API，CLI 必须在零输出边界内重试并完成代码修改与测试；
- 计划模式恢复：跨两个 CLI 进程恢复会话并完成修改；
- 模式边界恢复：在 Yolo 中故意调用一次 ExitPlanMode，运行时必须返回 `validation_error`，模型随后继续 Write/Bash，证明过期规划状态不能终止已经批准的工作；
- 失败恢复：先重现测试失败，再修改，最后验证通过；
- 超时恢复：回收完整进程树后继续工具循环，并确认没有后代进程遗留；
- session 退出回收：模型启动后台进程后正常结束 CLI，验证 runtime dispose 等待整棵进程树终止；
- 中断恢复：真实信号中断活动工具调用，持久化一次模型可见的中断边界，再由第二个 CLI 安全恢复；
- session 独占：活动 runtime 拒绝第二个同 session CLI 且不持久化其输入，owner 退出后允许恢复并继续验证；
- transcript 截断恢复：在 session JSONL 尾部制造未提交半行，恢复后完成 Write/Bash 任务，并逐行验证修复后的完整历史；
- 上下文压缩续跑：受限上下文窗口在 Read 后触发一次自动压缩；透明代理暂停真实摘要请求时，stdout 必须已实时发出 `compacting: started`，随后保持纯 JSONL、落盘自动摘要，并在 `compacting: completed` 之后执行 Write；
- Web surface：通过生产 HTTP session 路由提交任务并消费真实 SSE，验证代码修改、宿主测试、canonical tool success，以及 `compaction.started` / `compaction.completed` 在 resumed Write 之前按序可见；
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
