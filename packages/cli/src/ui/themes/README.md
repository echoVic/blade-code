# Blade 主题系统

## 文件结构

```
themes/
├── index.ts           # 统一导出入口
├── types.ts           # TypeScript 类型定义
├── utils.ts           # 工具函数
├── theme-manager.ts   # 核心主题管理器
├── presets.ts         # 预设主题集合
├── semantic-colors.ts # 语义化颜色管理
├── colors.ts          # 基础UI颜色 (向后兼容)
└── styles.ts          # UI样式工具 (向后兼容)
```

## 使用方法

### 基础用法

```typescript
import { themeManager, themes, getThemeById } from './themes';

// 设置主题 - 使用主题 ID
themeManager.setTheme('dracula');

// 获取当前主题
const currentTheme = themeManager.getTheme();

// 获取可用主题列表
const availableThemes = themeManager.getAvailableThemes();

// 遍历所有主题 (themes 是数组)
themes.forEach(item => {
  console.log(`${item.label} (${item.id})`);
  // 输出: "Dracula (dracula)"
});

// 根据 ID 获取主题配置
const draculaTheme = getThemeById('dracula');
```

### 自定义主题

```typescript
import { ThemeManager, Theme } from './themes';

const customTheme: Theme = {
  name: 'custom',
  colors: { /* ... */ },
  spacing: { /* ... */ },
  typography: { /* ... */ },
  borderRadius: { /* ... */ },
  boxShadow: { /* ... */ },
};

themeManager.addTheme('custom', customTheme);
```

### 语义化颜色

```typescript
import { SemanticColorManager } from './themes';

const semanticColors = new SemanticColorManager(currentTheme);
const primaryText = semanticColors.getTextColor('heading');
const cardBackground = semanticColors.getBackgroundColor('card');
```

## 可用主题

| ID | 显示名称 | 标签 |
|---|---|---|
| `ayu-dark` | Ayu Dark | dark, popular |
| `dracula` | Dracula | dark, popular |
| `monokai` | Monokai | dark, classic |
| `nord` | Nord | dark, minimal |
| `solarized-light` | Solarized Light | light |
| `solarized-dark` | Solarized Dark | dark |
| `tokyo-night` | Tokyo Night | dark, popular |
| `github` | GitHub | light, minimal |
| `gruvbox` | Gruvbox | dark, warm |
| `one-dark` | One Dark | dark, popular |
| `catppuccin` | Catppuccin | dark, pastel |
| `rose-pine` | Rose Pine | dark, elegant |
| `kanagawa` | Kanagawa | dark, japanese |

### 按标签筛选

```typescript
// 获取所有暗色主题
const darkThemes = themes.filter(t => t.tags?.includes('dark'));

// 获取热门主题
const popularThemes = themes.filter(t => t.tags?.includes('popular'));

// 获取浅色主题
const lightThemes = themes.filter(t => t.tags?.includes('light'));
```