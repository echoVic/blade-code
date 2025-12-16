# 🎨 主题系统

Blade 内置 13 套终端主题（详见 `src/ui/themes/presets.ts`），并在启动时根据配置加载。主题切换与配置完全在本地完成，无需网络。

## 内置主题

`ayu-dark`、`dracula`、`monokai`、`nord`、`solarized-light`、`solarized-dark`、`tokyo-night`、`github`、`gruvbox`、`one-dark`、`catppuccin`、`rose-pine`、`kanagawa`。

## 使用方式

- **配置文件**：在 `config.json` 中设置 `theme`，例如 `"theme": "dracula"`。
- **运行时切换**：在 UI 输入 `/theme` 打开主题选择器，立即生效并写回配置。

> 当前代码未实现 CLI 子命令切换主题，也未提供环境变量入口。

## 自定义主题

自定义主题可通过代码扩展（`themeManager.addTheme`），但官方发行版未暴露配置文件入口。若需自定义，可在本地 fork 后按 `Theme` 接口定义颜色、间距、字体等字段。

## 相关实现

- 主题定义与列表：`src/ui/themes/presets.ts`、`src/ui/themes/types.ts`
- 主题管理：`src/ui/themes/ThemeManager.ts`
- Slash 入口：`src/slash-commands/theme.ts`
