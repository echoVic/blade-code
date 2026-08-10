# Session Permission Mode

Blade 将权限模式作为 Session 自己拥有的 durable 安全状态，而不是只存在于当前进程
或 UI Store 的临时开关。公开值为：

```text
default
autoEdit
yolo
plan
```

## 恢复优先级

每次冷启动、resume、fork 或 runtime 重建都使用相同优先级：

1. 当前调用显式指定的 CLI/Web/ACP mode；
2. Session JSONL 中最后一次成功持久化的 `permissionMode`；
3. 当前入口的新 Session 默认值。

显式覆盖必须先写入 JSONL，随后才能准备 user input 或启动 Agent。持久化失败时本轮
不会开始，也不会只修改 UI 内存状态。Legacy Session 没有该字段时使用入口默认值，
并在第一次显式选择或执行前补写。

## 跨端语义

### TUI

Shift+Tab、进入 Plan 模式和 `--permission-mode` 都在当前 Session 上生效。会话选择器
恢复历史 Session 时同步恢复状态栏模式；显式 CLI 参数高于历史值。fork 子 Session
继承源 Session 在 fork 边界前最后提交的模式。

### Web

Session Composer 选择器绑定当前 Session。切换历史任务时使用 catalog 中的 durable
模式，`session.updated` 会跨 tab 同步。点击新任务会重置为 `autoEdit`，不会继承刚才
访问的 `yolo` 或 `plan` Session。

`POST /sessions/:sessionId/message` 的 `permissionMode` 是显式覆盖。省略时服务端使用
Session metadata，不回退到浏览器 Store 或进程全局配置。活动回合期间不能切换模式；
steering 继续沿用该回合已经冻结的模式。

### ACP

`session/load` 和 `session/fork` 返回：

```json
{
  "modes": {
    "currentModeId": "yolo"
  }
}
```

ACP 使用 `auto-edit` 表示 Blade 的 `autoEdit`。`session/set_mode` 在发送
`current_mode_update` 前先持久化；失败时客户端不会收到虚假的成功状态。崩溃后恢复的
pending input 与 goal continuation 使用同一 Session 模式。

### Headless / Print

`--resume` 和 `--continue` 会恢复 durable 模式。显式 `--permission-mode` 或 `--yolo`
优先并覆盖 Session 状态。Headless 新 Session 仍默认 `yolo`；Print 使用其运行时配置
默认值。

## Plan 模式切换

Agent 获得 `ExitPlanMode` 批准后，顺序固定为：

1. fsync 新的 Session `permissionMode`；
2. 通知当前 surface 更新 mode；
3. 更新进程内 Store；
4. 使用批准后的 plan 继续执行。

因此即使进程在批准后崩溃，下一次 resume 也不会回到陈旧的 `plan` 状态。

## 验证

准出要求同时覆盖：

- latest-update-wins、fork 继承、legacy fallback 和非法值 fail closed；
- 显式覆盖先于 input preparation，持久化失败零执行；
- TUI/Web/ACP/headless/print 冷恢复；
- Web 新任务从历史 YOLO Session 返回 `autoEdit`；
- SessionStart Hooks 与主 Agent 使用相同 runtime snapshot；
- 真实模型在未携带 mode 的恢复请求中实际调用写工具，且不会出现审批请求。
