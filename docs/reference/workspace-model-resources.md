# Workspace Model/Provider Runtime Isolation

Blade 的进程 Store 只表示启动项目的 UI 投影。Web 多项目、ACP 多 cwd、Task worktree
和后台 Subagent 不能从该 Store 查找运行模型或 Provider endpoint。

## Session 模型快照

`SessionRuntime.create()` 先确定不可变的 source `projectRoot`，再通过
`resolveWorkspaceModelResources()` 重建该项目的模型配置：

1. 用户 `config.json` 与 `settings.json`
2. 通过 Workspace Trust 的目标项目 `config.json`
3. 目标项目 `settings.json` 与 `settings.local.json`
4. 当前 invocation 的显式 runtime settings
5. `BLADE_MODEL` 选择

`models` 由后层整体替换，`modelProviders` 按 channel ID 合并。目标项目未信任时，其
模型、endpoint、环境变量和默认选择全部忽略。

解析结果包含：

- 深复制的 `BladeConfig`
- Session 私有 `PiModelCatalog`
- canonical source `projectRoot`

catalog 使用共享的安全 CredentialStore，但 Provider definitions、模型 metadata、
endpoint 和 lazy fallback 注册均不共享可变状态。`resolveModelConfig()` 将该 catalog
继续绑定到 `ChatConfig`，因此初始模型、运行时切换和 fallback 都使用同一快照。

## 子 Session 与 Hook

Task、Team、foreground/background Subagent 和 resume 显式继承父 Session 的
`SessionModelResources`，子 Runtime 再复制 catalog。项目配置在父 Session 创建后
发生变化，不会改变 child 的模型路由。

Prompt Hook 通过 `(sessionId, executionRoot)` 绑定所属 Runtime 快照。worktree 同时
注册 source root 与 execution root；Runtime dispose 会解除绑定并清理 Hook
ChatService。没有 Session owner 的独立 Hook 调用才按精确 `projectDir` 临时解析。

## 表面一致性

- CLI/TUI：显式 `--model` 在 source project 快照中 fail-closed 校验。
- Web：任务 dispatch 按 `sourceProjectPath` 解析；消息切换按现有 Runtime 校验；
  `/models` 使用 `x-blade-directory`。前端丢弃迟到的旧 workspace 响应。
- ACP：`session/new`、`session/load` 与 `session/fork` 的 model config options 来自
  已初始化 Session，不读取启动 Store。
- Worktree：仅改变文件执行目录；模型与 Provider 身份仍来自 source project。

## 资格验证

确定性测试让项目 A/B 使用相同 provider ID 与 model config ID、不同 endpoint。创建
快照后同时修改磁盘配置和全局 catalog，两个 Pi runtime 仍只能解析各自 endpoint。

真实 API 测试让两个本地记录代理转发同一 GPT 上游。两个并发 Session 各经过一个
代理且成功完成采样；磁盘与全局 catalog 被改到故障端口后，活动 Session 仍保持原
路由。Production Web GUI 绑定 A/B 两项目，项目切换后模型按钮和展开列表分别只显示
`GUI Model A` 或 `GUI Model B`，回切恢复且浏览器 console 为空。

## 相关资源

- [Workspace Agent 资源隔离](workspace-agent-resources.md)
- [Workspace Trust](../guides/workspace-trust.md)
- [模型传输恢复](model-transport-recovery.md)
- [测试与生产准出](../testing/qualification.md)
