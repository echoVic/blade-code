# TUI Terminal Input

Blade TUI 将终端输入建模为有状态协议，而不是假设每次 stdin 回调只包含一个字符。
这保证普通输入、IME commit、终端 paste 和自动化批量输入使用同一内容语义。

## Bracketed Paste

TUI 挂载时启用 DEC bracketed paste：

```text
CSI ? 2004 h
```

支持完整或跨 chunk 的 paste 边界：

```text
ESC [ 200 ~
<payload>
ESC [ 201 ~
```

Ink 会移除开头的 `ESC`，因此解析器同时接受 `[200~` / `[201~`。退出、卸载、
SIGINT 和 SIGTERM 都会发送 `CSI ? 2004 l`，避免 shell 残留 paste mode。

Blade 不依赖 terminal focus reporting，并在启动与退出时发送 `CSI ? 1004 l`。
独立的 `[I` / `[O` focus report 会被过滤，但用户文本内部的字面量不会被删除。

## Batched Input

一次 stdin 回调可能包含：

- 单个按键；
- 完整粘贴内容；
- IME 一次提交的多个字符；
- Computer Use 或测试桥接写入的整段文本。

`CustomTextInput` 对 multi-character chunk 一次完整插入。连续字符即使发生在同一个
React batch 内，也会先同步更新内部 value/cursor ref，再通知外部状态，因此后一个
字符不会基于旧 render state 覆盖前一个字符。

CRLF 和单独 CR 会统一为 LF。大文本与多行文本继续使用 paste mapping，在 UI 中显示
有界摘要，提交时恢复原文；图片路径仍走图片 paste 流程。

## 安全边界

- bracketed paste marker 只控制 framing，不进入用户消息；
- 未闭合 paste 会保留在 parser buffer，不提前提交半段文本；超过共享 32,000 字符
  消息预算后会丢弃到 end marker，避免异常终端造成无界内存增长；
- terminal mode 只在 TTY stdout 启用；
- terminal mode cleanup 不依赖 React 正常退出，GracefulShutdown 会再次复位；
- `/`、`@`、`!`、快捷键、历史和 permission mode 在 framing 后按原语义处理；
- Web Composer 与 ACP 不使用终端 CSI，但共享最终 Session input contract。

## 资格要求

确定性门禁必须覆盖：

1. 普通 multi-character stdin chunk；
2. 同一 React batch 内的快速逐字符回调；
3. 完整与 split bracketed paste；
4. CRLF 规范化；
5. focus CSI 过滤和字面量保留；
6. TTY mode 启用与恢复；
7. raw Ink stdin 提交；
8. `! <command>` 路由和完整进程树取消。

真实 API 门禁必须使用 production `dist/blade.js`、真实 PTY 和 transparent proxy，
直接观察完整 pasted prompt 进入 provider request body，并完成模型响应。非 raw stdin
或只渲染启动截图不能作为 TUI 输入资格。

Computer Use 只有在自动化桥接能稳定绑定独立终端窗口、保持 raw TTY 焦点并完整提交
命令时计入通过；多实例窗口无法按 bundle/window ID 稳定寻址时应记录为工具限制。
