# 🔒 权限系统

本文对应当前实现的 `PermissionChecker` / `ExecutionPipeline`，描述 allow/ask/deny 规则、权限模式以及确认持久化行为。

## 权限级别与匹配

- `allow`：自动允许执行。
- `ask`：需要用户确认。
- `deny`：直接拒绝（最高优先级）。

匹配顺序：`deny` > `allow` > `ask` > 默认（ask）。规则通过 `picomatch` 支持精确、前缀、`*`/`**` 通配和带参数的 glob：

```json
{
  "permissions": {
    "allow": [
      "Read(file_path:**/*.ts)",
      "Grep"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Bash(rm -rf *)"
    ]
  }
}
```

签名格式：`Tool(param1:value1, param2:value2)`；`*` / `**` 可匹配任意内容，参数值同样支持 glob。

## 权限模式

权限模式在权限阶段强制覆盖结果：

| 模式 | 自动允许 | 拒绝 | 说明 |
| --- | --- | --- | --- |
| `default` | 所有只读工具 | - | 只读工具（Read、Glob、Grep、WebFetch、WebSearch、BashOutput、TodoWrite、Plan 工具、Task）直接通过。 |
| `autoEdit` | 只读 + Write 类工具（Edit/Write/NotebookEdit） | - | 适合频繁改文件。 |
| `yolo` | 所有工具 | - | 跳过所有确认，需自担风险。 |
| `plan` | 只读工具 | 其他全部拒绝 | 适合调研/方案阶段，必须用 ExitPlanMode 提交方案后再切换模式。 |

> UI 中 `Shift+Tab` 循环 `default → autoEdit → plan`，`yolo` 需通过 CLI/配置设置。

## 确认与持久化

- 当规则判定为 `ask` 时，`ConfirmationStage` 会调用 UI 的确认弹窗。
- 选择“会话内记住”会把抽象后的规则写入 `.blade/settings.local.json`，立即刷新内存配置，后续同类操作不再弹窗。
- 抽象逻辑由各工具的 `abstractPermissionRule` 提供，例如：
  - Bash：提取主命令，记为 `Bash(command:npm *)` 等；
  - Edit/Write：基于 `file_path` 生成 `Edit(file_path:**/*.ts)`；
  - WebFetch/WebSearch：生成域名级或 `search:*` 规则；
  - Task/SlashCommand 返回空字符串（不自动生成规则）。

## 配置位置

行为配置存放在 `settings.json` / `settings.local.json`（加载顺序见配置系统章节），示例：

```json
{
  "permissionMode": "default",
  "permissions": {
    "allow": [
      "Bash(git status*)",
      "Read(file_path:**/*.md)"
    ],
    "ask": [
      "Write",
      "Edit"
    ],
    "deny": [
      "Read(file_path:**/.env*)",
      "Bash(sudo *)"
    ]
  }
}
```

## 最佳实践

- **保护敏感文件**：`Read(file_path:**/.env*)`、`Read(file_path:**/*.pem)`。
- **限制危险命令**：`Bash(rm -rf *)`、`Bash(sudo *)`。
- **按文件类型放行读取**：`Read(file_path:**/*.{ts,tsx,js,jsx,md,json})`。
- **按命令族放行**：`Bash(git *)`、`Bash(npm run *)`。
- 使用 `settings.local.json` 存放个人信任规则，避免提交到仓库。

## 相关代码

- 权限判定：`src/config/PermissionChecker.ts`
- 模式覆盖与确认：`src/tools/execution/PipelineStages.ts`
- 默认规则与模式枚举：`src/config/defaults.ts`、`src/config/types.ts`
- 自动落盘：`configActions().appendLocalPermissionAllowRule`（由确认阶段调用）
