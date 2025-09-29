/**
 * 语义化颜色管理系统
 */
import type { Theme } from './types.js';

// 语义化颜色映射
export interface SemanticColorMapping {
  // 文本语义色
  text: {
    heading: string; // 标题文本
    body: string; // 正文文本
    caption: string; // 辅助文本
    link: string; // 链接文本
    success: string; // 成功文本
    warning: string; // 警告文本
    error: string; // 错误文本
    info: string; // 信息文本
    disabled: string; // 禁用文本
    inverted: string; // 反转文本
  };

  // 背景语义色
  background: {
    page: string; // 页面背景
    card: string; // 卡片背景
    modal: string; // 模态框背景
    popover: string; // 弹出层背景
    success: string; // 成功背景
    warning: string; // 警告背景
    error: string; // 错误背景
    info: string; // 信息背景
    disabled: string; // 禁用背景
    inverted: string; // 反转背景
  };

  // 边框语义色
  border: {
    default: string; // 默认边框
    focus: string; // 焦点边框
    success: string; // 成功边框
    warning: string; // 警告边框
    error: string; // 错误边框
    info: string; // 信息边框
    disabled: string; // 禁用边框
    divider: string; // 分割线
  };

  // 交互语义色
  interactive: {
    primary: string; // 主要交互色
    secondary: string; // 次要交互色
    accent: string; // 强调交互色
    hover: string; // 悬停状态
    active: string; // 激活状态
    focus: string; // 焦点状态
    disabled: string; // 禁用状态
  };

  // 状态语义色
  status: {
    success: string; // 成功状态
    warning: string; // 警告状态
    error: string; // 错误状态
    info: string; // 信息状态
    pending: string; // 待处理状态
    draft: string; // 草稿状态
  };

  // 功能语义色
  functional: {
    highlight: string; // 高亮色
    selection: string; // 选中色
    overlay: string; // 遮罩色
    shadow: string; // 阴影色
    backdrop: string; // 背景色
  };
}

// 语义化颜色管理器
export class SemanticColorManager {
  private theme: Theme;
  private semanticColors: SemanticColorMapping;

  constructor(theme: Theme) {
    this.theme = theme;
    this.semanticColors = this.generateSemanticColors(theme);
  }

  /**
   * 生成语义化颜色映射
   * @param theme 主题配置
   * @returns 语义化颜色映射
   */
  private generateSemanticColors(theme: Theme): SemanticColorMapping {
    const { colors } = theme;

    return {
      text: {
        heading: colors.text.primary,
        body: colors.text.primary,
        caption: colors.text.secondary,
        link: colors.primary,
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
        info: colors.info,
        disabled: colors.muted,
        inverted: colors.text.light,
      },
      background: {
        page: colors.background.primary,
        card: colors.background.primary,
        modal: colors.background.primary,
        popover: colors.background.secondary,
        success: colors.success + '20', // 透明度处理
        warning: colors.warning + '20',
        error: colors.error + '20',
        info: colors.info + '20',
        disabled: colors.background.secondary,
        inverted: colors.background.dark,
      },
      border: {
        default: colors.border.light,
        focus: colors.primary,
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
        info: colors.info,
        disabled: colors.border.light,
        divider: colors.border.light,
      },
      interactive: {
        primary: colors.primary,
        secondary: colors.secondary,
        accent: colors.accent,
        hover: this.adjustColorBrightness(colors.primary, 0.1),
        active: this.adjustColorBrightness(colors.primary, -0.1),
        focus: colors.primary,
        disabled: colors.muted,
      },
      status: {
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
        info: colors.info,
        pending: colors.warning,
        draft: colors.muted,
      },
      functional: {
        highlight: colors.highlight,
        selection: colors.primary + '30', // 透明度处理
        overlay: colors.background.dark + '80',
        shadow: colors.border.dark + '20',
        backdrop: colors.background.dark + '60',
      },
    };
  }

  /**
   * 调整颜色亮度
   * @param color 原始颜色
   * @param amount 调整量 (-1 到 1)
   * @returns 调整后的颜色
   */
  private adjustColorBrightness(color: string, amount: number): string {
    // 移除 # 前缀
    const c = color.replace('#', '');

    // 解析 RGB 值
    let r = parseInt(c.substring(0, 2), 16);
    let g = parseInt(c.substring(2, 4), 16);
    let b = parseInt(c.substring(4, 6), 16);

    // 调整亮度
    r = Math.min(255, Math.max(0, r + amount * 255));
    g = Math.min(255, Math.max(0, g + amount * 255));
    b = Math.min(255, Math.max(0, b + amount * 255));

    // 转换回十六进制
    return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
  }

  /**
   * 更新主题
   * @param theme 新主题
   */
  updateTheme(theme: Theme): void {
    this.theme = theme;
    this.semanticColors = this.generateSemanticColors(theme);
  }

  /**
   * 获取语义化颜色
   * @param category 颜色分类
   * @param key 颜色键名
   * @returns 颜色值
   */
  getColor(category: keyof SemanticColorMapping, key: string): string {
    const categoryColors = this.semanticColors[category];
    if (categoryColors && key in categoryColors) {
      return categoryColors[key as keyof typeof categoryColors];
    }
    return '#000000'; // 默认颜色
  }

  /**
   * 获取所有语义化颜色
   * @returns 语义化颜色映射
   */
  getAllColors(): SemanticColorMapping {
    return this.semanticColors;
  }

  /**
   * 获取文本语义色
   * @param key 键名
   * @returns 颜色值
   */
  getTextColor(key: keyof SemanticColorMapping['text']): string {
    return this.semanticColors.text[key];
  }

  /**
   * 获取背景语义色
   * @param key 键名
   * @returns 颜色值
   */
  getBackgroundColor(key: keyof SemanticColorMapping['background']): string {
    return this.semanticColors.background[key];
  }

  /**
   * 获取边框语义色
   * @param key 键名
   * @returns 颜色值
   */
  getBorderColor(key: keyof SemanticColorMapping['border']): string {
    return this.semanticColors.border[key];
  }

  /**
   * 获取交互语义色
   * @param key 键名
   * @returns 颜色值
   */
  getInteractiveColor(key: keyof SemanticColorMapping['interactive']): string {
    return this.semanticColors.interactive[key];
  }

  /**
   * 获取状态语义色
   * @param key 键名
   * @returns 颜色值
   */
  getStatusColor(key: keyof SemanticColorMapping['status']): string {
    return this.semanticColors.status[key];
  }

  /**
   * 获取功能语义色
   * @param key 键名
   * @returns 颜色值
   */
  getFunctionalColor(key: keyof SemanticColorMapping['functional']): string {
    return this.semanticColors.functional[key];
  }
}
