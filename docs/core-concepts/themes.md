# 🎨 Blade 主题系统

Blade 提供了强大的主题系统，支持 13 种内置主题和自定义主题，让 CLI 界面更加美观和个性化。

## 📋 支持的主题

### 内置主题
Blade 内置了 13 种流行的主题配色方案：

| 主题名称 | 类型 | 描述 |
|---------|------|------|
| `ayu-dark` | 深色 | Ayu 深色主题，现代简洁 |
| `dracula` | 深色 | 经典 Dracula 配色方案 |
| `monokai` | 深色 | Monokai 编辑器配色 |
| `nord` | 深色 | Nord 配色主题 |
| `solarized-light` | 浅色 | Solarized 浅色主题 |
| `solarized-dark` | 深色 | Solarized 深色主题 |
| `tokyo-night` | 深色 | 东京夜晚主题 |
| `github` | 浅色 | GitHub 配色方案 |
| `gruvbox` | 深色 | Gruvbox 复古配色 |
| `one-dark` | 深色 | Atom One Dark 主题 |
| `catppuccin` | 深色 | Catppuccin 温柔配色 |
| `rose-pine` | 深色 | Rose Pine 优雅主题 |
| `kanagawa` | 深色 | Kanagawa 日式主题 |

## 🎯 主题配置

### 项目级配置
在项目配置文件 `.blade/settings.local.json` 中设置主题：

```json
{
  "ui": {
    "theme": "dracula"
  }
}
```

### 环境变量
使用环境变量设置主题：

```bash
export BLADE_THEME="tokyo-night"
```

### CLI 参数
通过命令行参数指定主题：

```bash
blade chat --theme nord "你好"
```

## ⚡ 动态主题切换

Blade 支持运行时动态切换主题：

```bash
# 查看可用主题
blade theme list

# 切换主题
blade theme set dracula

# 重置为默认主题
blade theme reset
```

## 🎨 自定义主题

### 创建自定义主题
创建自定义主题配置文件 `~/.blade/themes/custom.json`：

```json
{
  "name": "my-theme",
  "colors": {
    "primary": "#0066cc",
    "secondary": "#6c757d",
    "accent": "#e83e8c",
    "success": "#28a745",
    "warning": "#ffc107",
    "error": "#dc3545",
    "info": "#17a2b8",
    "light": "#f8f9fa",
    "dark": "#343a40",
    "muted": "#6c757d",
    "highlight": "#fff3cd",
    "text": {
      "primary": "#212529",
      "secondary": "#6c757d",
      "muted": "#6c757d",
      "light": "#ffffff"
    },
    "background": {
      "primary": "#ffffff",
      "secondary": "#f8f9fa",
      "dark": "#343a40"
    },
    "border": {
      "light": "#dee2e6",
      "dark": "#495057"
    }
  },
  "spacing": {
    "xs": 0.25,
    "sm": 0.5,
    "md": 1,
    "lg": 1.5,
    "xl": 2
  },
  "typography": {
    "fontSize": {
      "xs": 0.75,
      "sm": 0.875,
      "base": 1,
      "lg": 1.125,
      "xl": 1.25,
      "2xl": 1.5,
      "3xl": 1.875
    },
    "fontWeight": {
      "light": 300,
      "normal": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    }
  },
  "borderRadius": {
    "sm": 0.125,
    "base": 0.25,
    "lg": 0.5,
    "xl": 0.75
  },
  "boxShadow": {
    "sm": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    "base": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
    "lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)"
  }
}
```

### 注册自定义主题
在用户配置文件 `~/.blade/config.json` 中注册自定义主题：

```json
{
  "themes": {
    "my-theme": "~/.blade/themes/custom.json"
  }
}
```

## 🧠 语义化颜色系统

Blade 使用语义化颜色系统，将颜色映射到具体用途：

### 文本语义色
- `heading` - 标题文本
- `body` - 正文文本
- `caption` - 辅助文本
- `link` - 链接文本
- `success` - 成功文本
- `warning` - 警告文本
- `error` - 错误文本
- `info` - 信息文本
- `disabled` - 禁用文本
- `inverted` - 反转文本

### 背景语义色
- `page` - 页面背景
- `card` - 卡片背景
- `modal` - 模态框背景
- `popover` - 弹出层背景
- `success` - 成功背景
- `warning` - 警告背景
- `error` - 错误背景
- `info` - 信息背景
- `disabled` - 禁用背景
- `inverted` - 反转背景

### 交互语义色
- `primary` - 主要交互色
- `secondary` - 次要交互色
- `accent` - 强调交互色
- `hover` - 悬停状态
- `active` - 激活状态
- `focus` - 焦点状态
- `disabled` - 禁用状态

## 🔧 开发者 API

### 主题管理器
```typescript
import { themeManager } from 'blade-ai/ui';

// 获取当前主题
const theme = themeManager.getTheme();

// 切换主题
themeManager.setTheme('dracula');

// 添加自定义主题
themeManager.addTheme('my-theme', customTheme);

// 验证主题配置
const isValid = themeManager.validateTheme(themeConfig);
```

### 语义化颜色
```typescript
import { SemanticColorManager } from 'blade-ai/ui/themes';

// 创建语义化颜色管理器
const semanticColors = new SemanticColorManager(theme);

// 获取语义化颜色
const textColor = semanticColors.getTextColor('heading');
const bgColor = semanticColors.getBackgroundColor('card');
```

## 🌟 最佳实践

### 选择合适的主题
- **深色主题**：适合夜间使用或 OLED 屏幕
- **浅色主题**：适合白天使用或印刷输出
- **高对比度主题**：适合视力障碍用户

### 团队协作
```bash
# 项目使用统一主题
echo '{"ui": {"theme": "github"}}' > .blade/settings.local.json

# 个人偏好不提交
echo '{"ui": {"theme": "dracula"}}' > ~/.blade/config.json
```

### 主题测试
```bash
# 测试不同主题效果
blade theme set nord && blade chat "测试显示效果"
blade theme set tokyo-night && blade chat "测试显示效果"
```

## 🛠️ 故障排除

### 主题不生效
1. 检查配置文件路径是否正确
2. 确认主题名称拼写无误
3. 验证主题配置格式是否正确

### 自定义主题加载失败
1. 检查 JSON 格式是否有效
2. 确认文件路径是否存在
3. 验证主题配置是否完整

### 颜色显示异常
1. 检查终端是否支持颜色显示
2. 确认终端颜色配置是否正确
3. 尝试切换其他主题测试

---
@2025 Blade AI