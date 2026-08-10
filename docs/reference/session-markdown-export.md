# Portable Session Markdown Export

Blade 可以把 active 或 archived Session 的 durable conversation 导出为可携带的
Markdown。导出器读取 JSONL 事件流的稳定快照，并应用所有 `session_rewound` 标记；
不会从当前 Provider context、Web 内存或 SQLite read model 拼接历史。

## 内容模型

默认导出包含：

- user 与 assistant 文本；
- 图片的 MIME 标签，不包含 data URL 或原始二进制；
- tool call、tool result、subagent 与 file-change activity；
- durable compaction summary；
- Session、项目名、模型、创建/更新时间和 active/archived 状态。

system recovery marker 与其他内部 system text 不进入导出。模型 reasoning 默认省略，
只有显式 `--reasoning` 或 `includeReasoning=true` 才会包含。reasoning 仍经过与普通
文本相同的 Unicode 和凭证清理。

每份文件头部包含：

```text
Content SHA-256: <hex>
Content bytes: <n>
Redactions: <n>
```

SHA-256 覆盖 Markdown 横线 `---` 后的完整 UTF-8 正文，不包含可变化的 metadata
头部。导出没有当前时间戳，因此同一 durable history、visibility 选项和清理规则会产生
相同正文摘要。

## 安全投影

所有文本先执行 NFKC、ANSI/control/隐藏 Unicode 清理和 credential pattern
redaction。tool activity 还会递归处理：

- `apiKey`、`authorization`、`password`、`secret`、`token` 等敏感键；
- Bearer token、`sk-*` key、AWS access key 和 private-key block；
- data URL 与其他内联二进制；
- workspace 根替换为 `.`，其他 Unix/Windows 绝对宿主路径替换为
  `[host-path]`；
- 带 user-info、query 或 fragment 的 URL 只保留无凭证的 origin/path。

单个 activity 的投影上限为 64 KiB，超出部分显式标记
`[activity truncated]`。完整 Markdown 上限为 16 MiB；超过时整个导出失败，不生成一份
伪装成完整历史的静默截断文件。

## CLI 与 TUI

```text
/export
/export reports/conversation.md
/export --reasoning
/export reports/conversation.md --reasoning
```

未指定路径时写入当前 workspace：

```text
blade-session-<session-id-prefix>.md
```

相对路径基于当前 workspace，`~/` 与绝对路径按用户显式输入解析。父目录按需创建，
文件使用 `0600` 权限和 exclusive create；已有目标不会被覆盖，失败的部分文件会清理。

## Web

active Session 行菜单和 footer Archive Popover 都提供 **Export Markdown**。前端读取
服务端安全文件名、SHA-256、message/activity/redaction 计数后创建一次性 Blob 下载；
缺少 provenance header 时拒绝下载。

HTTP 接口：

```http
GET /sessions/:sessionId/export?projectPath=/absolute/path
GET /sessions/:sessionId/export?projectPath=/absolute/path&includeReasoning=true
```

响应是 `text/markdown; charset=utf-8`，并设置：

```text
Cache-Control: no-store
Content-Disposition: attachment; filename="blade-session-....md"
X-Blade-Content-Sha256: ...
X-Blade-Export-Messages: ...
X-Blade-Export-Activities: ...
X-Blade-Export-Redactions: ...
```

`sessionId + projectPath` 使用与其他 Session route 相同的 exact workspace resolver。
读取 archived Session 不创建 Runtime，也不解除归档。

## ACP

ACP 没有标准 conversation-export 或原子 remote create-exclusive wire method。
因此 `/export` 把相同 Markdown 作为标准 `agent_message_chunk` 返回，不写宿主路径；
带 path 的调用 fail closed。ACP inline 上限为 1 MiB，超出时应使用 Web endpoint。

```text
/export
/export --reasoning
```

## 生产资格

确定性测试覆盖 rewind materialization、orphan tool result、part update、图片、summary、
reasoning visibility、credential/path/binary 清理、activity budget、正文 SHA-256、
active/archived exact workspace、0600 no-clobber、HTTP provenance、Web keyboard action
和 ACP inline 限制。

真实 GPT 必须调用 `Read` 读取同时包含公开 marker、伪 API key 和宿主路径的文件。
导出保留 call/result 和 marker，隐藏 key/path，并通过 TUI 文件写入与 ACP inline 两个
入口返回同一摘要。

production DeepSeek Web GUI 必须从 active row 和 archived Popover 各执行一次下载；
fresh tab 还要再次导出 archived Session。直接响应审计必须验证正文 hash、`no-store`、
安全文件名、active/archived 状态、marker 保留、凭证/宿主路径消失和零 application
console error。
