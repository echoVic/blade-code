# 🎨 主题系统

Blade 内置 13 套终端主题，支持运行时切换，无需重启。

## 内置主题

| 主题名 | 风格 | 说明 |
|--------|------|------|
| `github` | 浅色 | GitHub 风格（默认） |
| `ayu-dark` | 深色 | Ayu 深色主题 |
| `dracula` | 深色 | Dracula 经典主题 |
| `monokai` | 深色 | Monokai 经典主题 |
| `nord` | 深色 | Nord 极地主题 |
| `solarized-light` | 浅色 | Solarized 浅色 |
| `solarized-dark` | 深色 | Solarized 深色 |
| `tokyo-night` | 深色 | Tokyo Night 主题 |
| `gruvbox` | 深色 | Gruvbox 复古主题 |
| `one-dark` | 深色 | Atom One Dark |
| `catppuccin` | 深色 | Catppuccin 柔和主题 |
| `rose-pine` | 深色 | Rosé Pine 主题 |
| `kanagawa` | 深色 | Kanagawa 日式主题 |

## 使用方式

### 配置文件设置

在 `~/.blade/config.json` 或 `.blade/config.json` 中设置：

```json
{
  "codeTheme": "dracula"
}
```

旧版 `theme` 字段会在启动时自动迁移为 `codeTheme`；Web 明暗模式独立使用 `uiTheme`。

### 运行时切换

在交互界面输入 `/theme` 打开主题选择器：

```
/theme
```

选择后立即生效并自动保存到配置文件。

## 主题效果

主题会影响以下 UI 元素：

- **文本颜色** - 普通文本、高亮文本、错误提示
- **代码高亮** - 语法着色、关键字、字符串、注释
- **边框样式** - 面板边框、分隔线
- **状态指示** - 成功、警告、错误状态颜色
- **背景色** - 消息区、输入区背景

## 主题预览

### GitHub（默认浅色）

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ 浅色背景，清晰的对比度              │
│ 适合明亮环境使用                    │
└─────────────────────────────────────┘
```

### Dracula（深色）

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ 紫色调深色主题                      │
│ 护眼且美观                          │
└─────────────────────────────────────┘
```

### Tokyo Night（深色）

```
┌─────────────────────────────────────┐
│ 🗡️ Blade Code                       │
│ 蓝紫色调，现代感                    │
│ 流行的编辑器主题                    │
└─────────────────────────────────────┘
```

## 相关资源

- [配置系统](config-system.md) - 完整配置说明
- 主题源码：`src/ui/themes/presets.ts`
