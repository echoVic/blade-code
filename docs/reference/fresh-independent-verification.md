# Fresh Independent Verification

Blade 对主 Agent 的非平凡实现执行独立完成门禁。主 Agent 不能仅凭自己的测试结果或
最终说明结束；必须启动一个新的内置 `verification` subagent，并获得结构化 PASS。

## 触发范围

满足任一条件即视为非平凡实现：

- 本轮修改至少三个实现文件；
- 修改 backend、API、server、auth、security、database、migration、infrastructure
  或 workflow 路径；
- Bash 执行了无法证明为只读或验证命令的操作。

纯文档、测试、fixture、snapshot 变更不计入三文件阈值。受限 Agent 没有 Task 工具、
用户明确禁止委派、exactly-once Task 契约和 subagent 自身不会触发该门禁。

## Fresh PASS

门禁只接受：

1. Blade 保留的内置 `verification` 类型；
2. 新建、同步执行、`isolation="none"` 的 Task；
3. 恰好一个结构化终态标题：

```text
## Verification Result: PASS
```

`FAIL` 要求主 Agent修复问题后重新验证；`PARTIAL` 不得冒充成功，必须处理其中等级风险
后重新验证。达到有界重试上限仍没有 fresh PASS 时，run 以
`verification_failed` 终止。

Verifier PASS 后发生任何 Edit、Write、ApplyPatch、NotebookEdit 或潜在写入 Bash，
都会立即使证据失效。下一次完成尝试必须启动新的 verifier。

## 独立性与权限

- `verification` 名称为 Blade 保留名称，user/project/plugin/CLI 配置不能覆盖；
- runtime 覆写 Task prompt，注入原始请求和实际 changed files，父模型不能要求跳过
  项目已经配置的 test、lint、type-check 或 build；
- verifier 没有写工具，也不能启动 Task；
- 即使父会话是 YOLO，Verifier Bash 也只允许项目内 cwd、只读命令和验证命令；
- 本地 verifier Bash 运行在 workspace read-only sandbox：源码目录不可写，网络
  allowlist 为空，user home 与 Blade storage 不可读，进程只继承 PATH/locale/CI
  等最小环境，不继承 provider key 或 Session env；
- 后台执行、自定义 env、越界 cwd、`--fix`、snapshot update、管道、命令替换和文件
  重定向全部 fail closed；尾部 `2>&1` 仅合并 stderr/stdout，不写文件，因此允许。

## 持久化与跨端投影

每次 mutation 和 verifier verdict 都写入 durable tool metadata。Session 恢复按事件
顺序重建 mutation revision；旧 PASS 后存在新写入时仍会要求重新验证。

- TUI/Headless：subagent lifecycle 输出 type 与 `verification_verdict`；
- Web：verification 卡片显示 PASS/FAIL/PARTIAL，并在 server restart 后从
  `subtask_ref` 恢复；
- ACP：标准 Task `tool_call_update` 内容包含结构化 verification result。

内部 completion reminder 不作为最终用户消息显示。

## 资格要求

确定性测试覆盖三文件和高风险路径触发、PASS 后写入失效、FAIL/PARTIAL、重试耗尽、
reserved agent、YOLO 只读边界、durable restore 和 CLI/Web/ACP 投影。

真实 API 测试必须让主模型实际修改三个文件、尝试结束、被 runtime 强制启动新的
verifier，并由独立模型运行项目测试后返回 PASS。Production Web GUI 还必须验证唯一
verification 卡片、唯一 PASS badge、最终 marker、server restart 后恢复、零内部
reminder 和零 application console error。
