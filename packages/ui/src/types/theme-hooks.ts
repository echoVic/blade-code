/**
 * 主题系统React钩子类型定义
 */

import type { 
  DesignTokens, 
  ThemeConfig, 
  ThemeMode, 
  ThemeVariant 
} from './design-tokens';
import type { ThemeEvent, ThemeContext } from './theme-engine';

// 基础主题钩子选项
export interface ThemeHookOptions {
  // 是否在页面加载时同步主题
  syncWithSystem?: boolean;
  // 是否在本地存储中保存主题偏好
  persistTheme?: boolean;
  // 主题变化时的回调函数
  onThemeChange?: (theme: ThemeConfig) => void;
  // 模式变化时的回调函数
  onModeChange?: (mode: keyof ThemeMode) => void;
  // 是否启用过渡动画
  enableTransition?: boolean;
  // 默认主题
  defaultTheme?: string;
  // 默认模式
  defaultMode?: 'light' | 'dark';
}

// 自定义主题选项
export interface CustomThemeOptions {
  // 自定义主题名称
  name: string;
  // 自定义主题令牌
  tokens: Partial<DesignTokens>;
  // 是否基于现有主题
  baseTheme?: string;
  // 主题变体
  variants?: ThemeVariant[];
  // 自定义钩子
  hooks?: Record<string, (value: any) => any>;
}

// 主题消费者选项
export interface ThemeConsumerOptions {
  // 消费者作用域
  scope?: string;
  // 是否继承父级主题
  inherit?: boolean;
  // 自定义令牌覆盖
  overrideTokens?: Partial<DesignTokens>;
  // 事件监听器
  eventListeners?: Array<{
    event: ThemeEvent['type'];
    handler: ThemeEventHandler;
  }>;
}

// 主题样式选项
export interface ThemeStyleOptions<T = any> {
  // 样式生成器
  styles: (theme: ThemeConfig) => T;
  // 条件样式
  condition?: (theme: ThemeConfig) => boolean;
  // 依赖项
  deps?: any[];
  // 是否缓存结果
  memoize?: boolean;
}

// 主题变体选项
export interface ThemeVariantOptions {
  // 变体名称
  name: string;
  // 变体令牌
  tokens: Partial<DesignTokens>;
  // 变体条件
  condition?: (props: any) => boolean;
  // 变体优先级
  priority?: number;
}

// 主题组件选项
export interface ThemeComponentOptions {
  // 组件名称
  componentName: string;
  // 默认变体
  defaultVariant?: string;
  // 可用变体
  variants?: ThemeVariantOptions[];
  // 自定义样式
  customStyles?: (theme: ThemeConfig, props: any) => Record<string, any>;
  // 是否启用响应式设计
  responsive?: boolean;
  // 主题上下文继承
  inheritContext?: boolean;
}

// 主题事件处理器
export interface ThemeEventHandler {
  // 事件类型
  eventType: ThemeEvent['type'];
  // 处理函数
  handler: (event: ThemeEvent) => void;
  // 处理优先级
  priority?: number;
  // 是否只执行一次
  once?: boolean;
}

// 主题拖拽配置
export interface ThemeDragConfig {
  // 是否启用拖拽
  enabled: boolean;
  // 拖拽方向
  direction?: 'horizontal' | 'vertical' | 'both';
  // 拖拽边界
  bounds?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
  // 拖拽开始回调
  onDragStart?: (e: React.DragEvent) => void;
  // 拖拽回调
  onDrag?: (e: React.DragEvent) => void;
  // 拖拽结束回调
  onDragEnd?: (e: React.DragEvent) => void;
}

// 主题动画配置
export interface ThemeAnimationConfig {
  // 动画类型
  type: 'fade' | 'slide' | 'scale' | 'rotate' | 'bounce' | 'shake';
  // 动画持续时间
  duration?: number;
  // 动画延迟
  delay?: number;
  // 动画缓动函数
  easing?: string;
  // 动画重复次数
  repeat?: number | 'infinite';
  // 动画方向
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  // 动画填充模式
  fillMode?: 'none' | 'forwards' | 'backwards' | 'both';
}

// 主题响应式配置
export interface ThemeResponsiveConfig {
  // 响应式断点
  breakpoints: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  // 默认断点
  defaultBreakpoint?: keyof ThemeResponsiveConfig['breakpoints'];
  // 断点变化回调
  onBreakpointChange?: (breakpoint: string) => void;
  // 是否启用媒体查询
  enableMediaQuery?: boolean;
}

// 主题国际化配置
export interface ThemeI18nConfig {
  // 当前语言
  currentLanguage: string;
  // 默认语言
  defaultLanguage: string;
  // 可用语言
  availableLanguages: string[];
  // 语言切换回调
  onLanguageChange?: (language: string) => void;
  // 本地化资源
  resources: Record<string, Record<string, string>>;
}

// 主题无障碍配置
export interface ThemeAccessibilityConfig {
  // 是否启高对比度模式
  highContrast?: boolean;
  // 是否启用键盘导航
  enableKeyboardNavigation?: boolean;
  // 是否启用屏幕阅读器支持
  screenReaderSupport?: boolean;
  // 焦点管理配置
  focusManagement?: {
    // 焦点顺序
    order: string[];
    // 焦点样式
    style: Record<string, any>;
    // 焦点陷阱
    trap: boolean;
  };
  // ARIA属性
  aria?: Record<string, string>;
}

// 主题性能配置
export interface ThemePerformanceConfig {
  // 是否启用性能监控
  enableMonitoring?: boolean;
  // 性能指标阈值
  thresholds?: {
    themeLoadTime?: number;
    tokenResolveTime?: number;
    cacheHitRate?: number;
  };
  // 是否启用懒加载
  enableLazyLoading?: boolean;
  // 是否启用虚拟化
  enableVirtualization?: boolean;
  // 预加载主题
  preloadThemes?: string[];
}

// 主题开发配置
export interface ThemeDevConfig {
  // 是否启用开发模式
  enabled: boolean;
  // 是否启用调试工具
  enableDevTools?: boolean;
  // 是否启用热重载
  enableHotReload?: boolean;
  // 是否显示主题信息
  showThemeInfo?: boolean;
  // 是否启用性能分析
  enableProfiling?: boolean;
  // 是否启用主题仿真器
  enableThemeEmulator?: boolean;
  // 自定义开发工具
  devTools?: Record<string, (arg1: any, ...args: any[]) => any>;
}

// 主题测试配置
export interface ThemeTestConfig {
  // 测试主题
  testThemes: string[];
  // 测试模式
  testModes: Array<keyof ThemeMode>;
  // 测试用例
  testCases: Array<{
    name: string;
    test: () => boolean;
    expected: any;
  }>;
  // 测试钩子
  hooks?: {
    beforeAll?: () => void;
    afterAll?: () => void;
    beforeEach?: () => void;
    afterEach?: () => void;
  };
}

// 主题上下文值
export interface ThemeContextValue {
  // 当前主题
  theme: ThemeConfig;
  // 当前模式
  mode: keyof ThemeMode;
  // 当前变体
  variant?: ThemeVariant;
  // 设置主题
  setTheme: (themeId: string) => void;
  // 设置模式
  setMode: (mode: keyof ThemeMode) => void;
  // 设置变体
  setVariant: (variantId: string) => void;
  // 获取令牌值
  getToken: (path: string) => any;
  // 获取样式
  getStyles: (callback: (theme: ThemeConfig) => Record<string, any>) => Record<string, any>;
  // 添加事件监听器
  addEventListener: (event: ThemeEvent['type'], handler: ThemeEventHandler['handler']) => void;
  // 移除事件监听器
  removeEventListener: (event: ThemeEvent['type'], handler: ThemeEventHandler['handler']) => void;
  // 主题上下文链
  contextChain: ThemeContext[];
  // 主题配置
  options: ThemeHookOptions;
}

// 主题消费者属性
export interface ThemeConsumerProps {
  // 子组件
  children: (themeContext: ThemeContextValue) => React.ReactNode;
  // 消费者选项
  options?: ThemeConsumerOptions;
}

// 主题提供者属性
export interface ThemeProviderProps {
  // 子组件
  children: React.ReactNode;
  // 初始主题
  initialTheme?: string;
  // 初始模式
  initialMode?: keyof ThemeMode;
  // 主题选项
  options?: ThemeHookOptions;
  // 自定义主题
  customThemes?: ThemeConfig[];
  // 主题事件
  onThemeEvent?: (event: ThemeEvent) => void;
}

// 主题样式组件属性
export interface ThemeStyledComponentProps {
  // 组件名称
  as?: React.ElementType;
  // 组件样式
  style?: React.CSSProperties;
  // 组件变体
  variant?: string;
  // 组件尺寸
  size?: string;
  // 组件颜色
  color?: string;
  // 自定义属性
  [key: string]: any;
}

// 主题拖拽组件属性
export interface ThemeDragProps {
  // 子组件
  children: React.ReactNode;
  // 拖拽配置
  config?: ThemeDragConfig;
  // 拖拽数据
  data?: any;
  // 拖拽样式
  style?: React.CSSProperties;
  // 拖拽类名
  className?: string;
}

// 主题动画组件属性
export interface ThemeAnimationProps {
  // 子组件
  children: React.ReactNode;
  // 动画配置
  config: ThemeAnimationConfig;
  // 是否触发动画
  trigger?: boolean;
  // 动画样式
  style?: React.CSSProperties;
  // 动画类名
  className?: string;
}

// 主题响应式组件属性
export interface ThemeResponsiveProps {
  // 子组件
  children: React.ReactNode;
  // 响应式配置
  config?: ThemeResponsiveConfig;
  // 断点特定的子组件
  breakpoints?: Record<string, React.ReactNode>;
  // 响应式样式
  responsiveStyles?: Record<string, React.CSSProperties>;
}

// 主题国际化组件属性
export interface ThemeI18nProps {
  // 子组件
  children: React.ReactNode;
  // 国际化配置
  config: ThemeI18nConfig;
  // 翻译键
  i18nKey: string;
  // 默认值
  defaultValue?: string;
  // 插值参数
  interpolation?: Record<string, string>;
}

// 主题无障碍组件属性
export interface ThemeAccessibilityProps {
  // 子组件
  children: React.ReactNode;
  // 无障碍配置
  config: ThemeAccessibilityConfig;
  // ARIA属性
  ariaProps?: Record<string, string>;
  // 角色属性
  role?: string;
  // 标签属性
  label?: string;
  // 描述属性
  describedBy?: string;
}

// 主题性能组件属性
export interface ThemePerformanceProps {
  // 子组件
  children: React.ReactNode;
  // 性能配置
  config?: ThemePerformanceConfig;
  // 性能回调
  onPerformanceUpdate?: (metrics: any) => void;
  // 性能阈值
  thresholds?: Record<string, number>;
}

// 主题开发工具属性
export interface ThemeDevToolsProps {
  // 子组件
  children?: React.ReactNode;
  // 开发配置
  config?: ThemeDevConfig;
  // 开发工具位置
  position?: 'top' | 'bottom' | 'left' | 'right';
  // 初始状态
  initialOpen?: boolean;
}

// 主题测试组件属性
export interface ThemeTestProps {
  // 子组件
  children: React.ReactNode;
  // 测试配置
  config?: ThemeTestConfig;
  // 测试回调
  onTestComplete?: (results: any) => void;
  // 是否自动运行测试
  autoRun?: boolean;
}

// 主题工具栏属性
export interface ThemeToolbarProps {
  // 工具栏位置
  position?: 'top' | 'bottom' | 'left' | 'right';
  // 工具栏方向
  orientation?: 'horizontal' | 'vertical';
  // 工具栏样式
  style?: React.CSSProperties;
  // 工具栏类名
  className?: string;
  // 默认展开
  defaultOpen?: boolean;
}

// 主题切换器属性
export interface ThemeSwitcherProps {
  // 可用主题
  themes: string[];
  // 当前主题
  currentTheme: string;
  // 当前模式
  currentMode: keyof ThemeMode;
  // 主题切换回调
  onThemeChange: (theme: string) => void;
  // 模式切换回调
  onModeChange: (mode: keyof ThemeMode) => void;
  // 切换器样式
  style?: React.CSSProperties;
  // 切换器类名
  className?: string;
}

// 主题主题选择器属性
export interface ThemeSelectorProps extends ThemeSwitcherProps {
  // 选择器类型
  type?: 'dropdown' | 'tabs' | 'buttons' | 'slider';
  // 显示主题名称
  showThemeNames?: boolean;
  // 显示主题预览
  showPreview?: boolean;
  // 自定义选项
  customOptions?: Record<string, any>;
}

// 主题令牌浏览器属性
export interface ThemeTokenBrowserProps {
  // 主题令牌
  tokens?: DesignTokens;
  // 过滤器
  filter?: string;
  // 是否搜索
  searchable?: boolean;
  // 是否展开
  defaultExpanded?: boolean;
  // 是否显示值类型
  showType?: boolean;
  // 是否显示路径
  showPath?: boolean;
}

// 主题设计器属性
export interface ThemeDesignerProps {
  // 设计主题
  designTheme?: ThemeConfig;
  // 设计回调
  onDesignChange?: (theme: ThemeConfig) => void;
  // 预设主题
  presetThemes?: ThemeConfig[];
  // 默认面板
  defaultPanel?: 'colors' | 'typography' | 'spacing' | 'layouts';
  // 是否实时预览
  livePreview?: boolean;
  // 是否保存到本地
  saveToLocal?: boolean;
}