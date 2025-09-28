/**
 * 主题适配器 - 连接Blade UI主题系统与Ink组件
 */

import React, { createContext, useContext, useMemo } from 'react';
// 临时主题配置类型定义
interface ThemeConfig {
  colors: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    border: string;
  };
  typography: {
    fontSize: number;
    lineHeight: number;
    fontFamily: string;
  };
  tokens: {
    [key: string]: any;
  };
  components: {
    [key: string]: any;
  };
}

// 内置主题
const builtinThemes = {
  default: {
    colors: {
      primary: '#007acc',
      secondary: '#6c757d',
      background: '#ffffff',
      text: '#333333',
      border: '#dee2e6'
    },
    typography: {
      fontSize: 14,
      lineHeight: 1.5,
      fontFamily: 'monospace'
    },
    tokens: {
      colors: {
        primary: '#007acc',
        secondary: '#6c757d',
        background: '#ffffff',
        text: '#333333',
        border: '#dee2e6'
      },
      spacing: {
        xs: 4,
        sm: 8,
        md: 16,
        lg: 24,
        xl: 32
      },
      typography: {
        fontSize: {
          sm: 12,
          md: 14,
          lg: 16,
          xl: 18
        }
      }
    },
    components: {
      Text: {
        primary: { color: '#333333' },
        secondary: { color: '#6c757d' },
        success: { color: '#28a745' },
        warning: { color: '#ffc107' },
        error: { color: '#dc3545' }
      },
      Box: {
        default: { backgroundColor: '#ffffff' },
        card: { backgroundColor: '#f8f9fa', border: '1px solid #dee2e6' }
      }
    }
  } as ThemeConfig
};

// 创建主题上下文
interface ThemeContextType {
  theme: ThemeConfig;
  getToken: (path: string) => any;
  getComponentStyle: (componentName: string, variant?: string) => React.CSSProperties;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// 默认主题
const DEFAULT_THEME = builtinThemes.default;

/**
 * 主题提供者组件
 */
export const ThemeProvider: React.FC<{
  children: React.ReactNode;
  theme?: ThemeConfig;
}> = ({ children, theme = DEFAULT_THEME }) => {
  // 获取令牌值
  const getToken = useMemo(() => {
    return (path: string): any => {
      const parts = path.split('.');
      let current: any = theme.tokens;
      
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return undefined;
        }
      }
      
      return current;
    };
  }, [theme]);

  // 获取组件样式
  const getComponentStyle = useMemo(() => {
    return (componentName: string, variant?: string): React.CSSProperties => {
      // 从主题中获取组件配置
      const componentConfig = theme.components?.[componentName];
      if (!componentConfig) {
        return {};
      }
      
      // 获取基础样式
      let style = componentConfig.style || {};
      
      // 如果有变体，合并变体样式
      if (variant && componentConfig.variants?.[variant]) {
        style = { ...style, ...componentConfig.variants[variant] };
      }
      
      return style;
    };
  }, [theme]);

  const contextValue = useMemo(() => ({
    theme,
    getToken,
    getComponentStyle,
  }), [theme, getToken, getComponentStyle]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

/**
 * 使用主题上下文
 */
export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/**
 * 使用主题令牌
 */
export const useToken = (path: string): any => {
  const { getToken } = useTheme();
  return getToken(path);
};

/**
 * 使用组件样式
 */
export const useComponentStyle = (componentName: string, variant?: string): React.CSSProperties => {
  const { getComponentStyle } = useTheme();
  return getComponentStyle(componentName, variant);
};

/**
 * 主题化组件包装器
 */
export const withTheme = <P extends object>(
  Component: React.ComponentType<P>,
  componentName: string
) => {
  const ThemedComponent: React.FC<P & { variant?: string }> = ({ variant, ...props }) => {
    const style = useComponentStyle(componentName, variant);
    
    return (
      <Component 
        {...props as P} 
        style={{ ...style, ...(props as any).style }} 
      />
    );
  };
  
  ThemedComponent.displayName = `Themed${Component.displayName || Component.name}`;
  return ThemedComponent;
};

/**
 * 主题化文本组件
 */
export const ThemedText: React.FC<{
  children: React.ReactNode;
  token?: string;
  variant?: string;
  style?: React.CSSProperties;
}> = ({ children, token, variant = 'primary', style }) => {
  const { theme, getToken } = useTheme();
  
  // 根据令牌获取颜色
  const color = token ? getToken(token) : undefined;
  
  // 根据变体获取默认颜色
  const getVariantColor = () => {
    switch (variant) {
      case 'primary': return theme.tokens.colors.semantic.primary[500];
      case 'secondary': return theme.tokens.colors.semantic.secondary[500];
      case 'success': return theme.tokens.colors.semantic.success[500];
      case 'warning': return theme.tokens.colors.semantic.warning[500];
      case 'error': return theme.tokens.colors.semantic.error[500];
      case 'info': return theme.tokens.colors.semantic.info[500];
      default: return theme.tokens.colors.text.primary;
    }
  };
  
  const finalColor = color || getVariantColor();
  
  return (
    <span style={{ color: finalColor, ...style }}>
      {children}
    </span>
  );
};

/**
 * 主题化容器组件
 */
export const ThemedBox: React.FC<{
  children: React.ReactNode;
  variant?: string;
  style?: React.CSSProperties;
}> = ({ children, variant = 'default', style }) => {
  const { theme } = useTheme();
  
  // 根据变体获取样式
  const getVariantStyle = () => {
    switch (variant) {
      case 'card':
        return {
          padding: theme.tokens.spacing.component.padding.md,
          border: `${theme.tokens.border.width.normal}rem solid ${theme.tokens.border.default}`,
          borderRadius: theme.tokens.border.radius.md,
          backgroundColor: theme.tokens.colors.functional.background.surface,
        };
      case 'section':
        return {
          padding: theme.tokens.spacing.component.padding.lg,
          margin: theme.tokens.spacing.component.margin.md,
        };
      case 'container':
        return {
          padding: theme.tokens.spacing.component.padding.md,
          maxWidth: theme.tokens.layout.container.lg,
        };
      default:
        return {};
    }
  };
  
  const variantStyle = getVariantStyle();
  
  return (
    <div style={{ ...variantStyle, ...style }}>
      {children}
    </div>
  );
};

export default {
  ThemeProvider,
  useTheme,
  useToken,
  useComponentStyle,
  withTheme,
  ThemedText,
  ThemedBox,
};