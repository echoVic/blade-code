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
import { themeManager, themes, THEME_NAMES } from './themes';

// 设置主题
themeManager.setTheme(THEME_NAMES.DRACULA);

// 获取当前主题
const currentTheme = themeManager.getTheme();

// 获取可用主题列表
const availableThemes = themeManager.getAvailableThemes();
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

- ayu-dark
- dracula
- monokai
- nord
- solarized-light
- solarized-dark
- tokyo-night
- github
- gruvbox
- one-dark
- catppuccin
- rose-pine
- kanagawa