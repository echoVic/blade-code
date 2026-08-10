# Workspace Trust

Workspace Trust 是项目级安全边界。仓库可以携带模型 endpoint、MCP 进程、权限规则、
环境变量、插件和模型可调用的指令资源；Blade 在用户信任目录前不会应用这些来源。

## 默认阻断的项目来源

- `.blade/config.json`
- `.blade/settings.json`
- `.blade/settings.local.json`
- 包含 `scripts` 的 `package.json`
- `.blade/plugins/`、`.claude/plugins/`
- `.blade/commands/`、`.claude/commands/`
- `.blade/skills/`、`.claude/skills/`
- `.blade/agents/`、`.claude/agents/`
- `CLAUDE.md`、`AGENTS.md`、`BLADE.md`

未信任时，Blade 只使用用户级配置、内置资源和显式 CLI 参数。项目不能：

- 替换当前模型或把 API key 发送到项目 endpoint；
- 启动 stdio MCP 或连接项目 HTTP/SSE MCP；
- 启动项目 LSP executable；
- 追加 `permissions.allow`、切换到 yolo 或注入 `BASH_ENV` 等环境变量；
- 加载 project plugins、commands、skills 或 agents；
- 把 repo instructions 注入系统提示；
- 在文件写入后自动执行项目 `type-check` 脚本。

`package.json` 审核只展示 script 名称，不返回命令正文。项目代码自动验证还要求当前
Session 使用 `yolo` 权限；`default` 和 `autoEdit` 不会在已批准的写操作后隐式启动
execute 类命令。未声明 `type-check` 时 Blade 不猜测工具，也不会通过 `npx` 下载执行。
ACP 文件由客户端持有，Blade 不会对 ACP 写入启动本地验证进程。

项目 Hooks 使用更严格的独立摘要信任。仅包含 `hooks` 的 settings 文件不触发
Folder Trust，但 command/http/prompt Hook 仍必须在
`Settings → Hooks` 或 `/hooks trust` 中按 SHA-256 摘要批准。Folder Trust 不会绕过
Hook 摘要审阅。

## 信任决策

Blade 使用 canonical project identity。Git linked worktree 映射到 common checkout，
同时保留 monorepo 子项目相对路径。父目录信任会继承到子目录；更具体的子目录 revoke
优先于父目录。

决策保存在：

```text
~/.blade/workspace-trust/<sha256(path)>.json
```

目录权限为 `0700`，decision 文件为 `0600`，并使用原子写。符号链接、错误 owner、
宽松权限、损坏 schema、用户 home 和文件系统根都 fail closed。

## CLI、TUI 与 ACP

TUI 在初始化项目资源前显示 review prompt：

```text
[Enter/T] Trust and load
[S/Esc] Continue safely
```

也可以使用：

```text
/trust
/trust review
/trust approve
/trust revoke
```

ACP 通过标准 slash-command callback 返回相同 review。自动化或 headless 启动可显式
授权：

```bash
blade --trust-workspace
blade --headless --trust-workspace "run the task"
blade --acp --trust-workspace
```

`--trust-workspace` 是显式安全决策，不应由仓库脚本自动添加。

## Web

Web 在 `Settings → Security` 展示：

- 配置来源路径；
- MCP command 或去除 query/credentials 的 URL；
- LSP command 与文件扩展名，不返回 args 或 env；
- 模型与 Provider endpoint；
- permission rules 和 permission mode；
- 环境变量名称，不返回值；
- package script 名称，不返回命令正文；
- project plugins、commands、skills、agents 和 instructions。

Trust/Revoke 均要求二次确认。决策后 Blade 立即重载过滤后的 Store、断开全局 MCP 并
清理项目资源 registry。已经创建的模型 runtime 需要重启进程才能完全替换，因此 UI
会保留 restart 提示。

## 安全模式

选择 `Continue safely` 不会信任目录。Blade 可以使用用户配置继续启动，但项目来源
保持不可见。以后可通过 `/trust approve` 或 Web Security 面板授权。

## 相关资源

- [配置系统](../configuration/config-system.md)
- [权限控制](../configuration/permissions.md)
- [Hooks](hooks.md)
- [测试与生产准出](../testing/qualification.md)
