import { useCallback, useState } from 'react';
import type { RouteConfig } from '../config/route-config.js';

export type AppView = 'main' | 'settings' | 'help' | 'logs' | 'tools' | 'chat' | 'config';

export interface NavigationState {
  currentView: AppView;
  history: AppView[];
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface UseAppNavigationReturn {
  currentView: AppView;
  history: AppView[];
  navigate: (view: AppView, options?: NavigationOptions) => void;
  goBack: () => void;
  goForward: () => void;
  goToHome: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  registerRoute: (route: RouteConfig) => void;
  getRouteConfig: (view: AppView) => RouteConfig | undefined;
}

export interface NavigationOptions {
  replace?: boolean;
  state?: Record<string, any>;
  preserveHistory?: boolean;
}

const defaultNavigationState: NavigationState = {
  currentView: 'main',
  history: ['main'],
  canGoBack: false,
  canGoForward: false,
};

// 路由注册表
const routeRegistry = new Map<AppView, RouteConfig>();

export const useAppNavigation = (): UseAppNavigationReturn => {
  const [navigationState, setNavigationState] = useState<NavigationState>(defaultNavigationState);

  const navigate = useCallback((view: AppView, options: NavigationOptions = {}) => {
    const { replace = false, preserveHistory = false } = options;
    
    setNavigationState(prevState => {
      let newHistory: AppView[];
      
      if (replace) {
        // 替换当前视图
        newHistory = [...prevState.history.slice(0, -1), view];
      } else if (preserveHistory) {
        // 保留历史记录，但不清除前进历史
        newHistory = [...prevState.history, view];
      } else {
        // 普通导航，清除前进历史
        newHistory = [...prevState.history, view];
      }

      return {
        currentView: view,
        history: newHistory,
        canGoBack: newHistory.length > 1,
        canGoForward: false, // 导航后清空前进历史
      };
    });

    // 触发导航事件
    const routeConfig = routeRegistry.get(view);
    if (routeConfig?.onNavigate) {
      routeConfig.onNavigate(view, options);
    }
  }, []);

  const goBack = useCallback(() => {
    setNavigationState(prevState => {
      if (prevState.history.length <= 1) {
        return prevState; // 无法返回
      }

      const newHistory = prevState.history.slice(0, -1);
      const newCurrentView = newHistory[newHistory.length - 1];

      return {
        currentView: newCurrentView,
        history: newHistory,
        canGoBack: newHistory.length > 1,
        canGoForward: true,
      };
    });
  }, []);

  const goForward = useCallback(() => {
    setNavigationState(prevState => {
      // 这里简化处理，实际应该维护一个前进历史栈
      return prevState; // 暂时无法前进
    });
  }, []);

  const goToHome = useCallback(() => {
    navigate('main', { replace: true });
  }, [navigate]);

  const registerRoute = useCallback((route: RouteConfig) => {
    routeRegistry.set(route.path as AppView, route);
  }, []);

  const getRouteConfig = useCallback((view: AppView): RouteConfig | undefined => {
    return routeRegistry.get(view);
  }, []);

  return {
    currentView: navigationState.currentView,
    history: navigationState.history,
    navigate,
    goBack,
    goForward,
    goToHome,
    canGoBack: navigationState.canGoBack,
    canGoForward: navigationState.canGoForward,
    registerRoute,
    getRouteConfig,
  };
};

// 导航历史Hook
export const useNavigationHistory = () => {
  const { history, goBack, goForward } = useAppNavigation();
  
  return {
    history,
    goBack,
    goForward,
    clearHistory: () => {
      // 清空导航历史（回到主页）
      // 这里需要访问并修改内部状态，暂时不实现
    },
  };
};

// 深度链接Hook
export const useDeepLink = () => {
  const navigate = useAppNavigation().navigate;
  
  const handleDeepLink = useCallback((url: string) => {
    try {
      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname.slice(1); // 去掉开头的'/'
      const params = Object.fromEntries(parsedUrl.searchParams);
      
      // 解析路径并导航
      if (['settings', 'help', 'logs', 'tools', 'chat', 'config'].includes(path)) {
        navigate(path as AppView, { state: params });
      } else {
        // 处理特殊的深度链接格式
        const [view, ...rest] = path.split('/');
        if (['settings', 'help', 'logs', 'tools', 'chat', 'config'].includes(view)) {
          navigate(view as AppView, { 
            state: { section: rest.join('/'), ...params }
          });
        }
      }
    } catch (error) {
      console.error('解析深度链接失败:', error);
    }
  }, [navigate]);

  return { handleDeepLink };
};

// 路由守卫Hook
export const useRouteGuard = () => {
  const navigate = useAppNavigation().navigate;
  
  const requireAuth = useCallback((targetView: AppView) => {
    const isAuthenticated = false; // 这里应该从认证状态获取
    
    if (!isAuthenticated) {
      // 导航到登录页面或显示认证对话框
      console.log('需要认证');
      return false;
    }
    
    return true;
  }, []);

  const requirePermission = useCallback((permission: string, targetView: AppView) => {
    const hasPermission = true; // 这里应该从权限系统获取
    
    if (!hasPermission) {
      console.log(`缺少权限: ${permission}`);
      return false;
    }
    
    return true;
  }, []);

  const navigateWithGuard = useCallback((view: AppView, options?: NavigationOptions) => {
    const routeConfig = routeRegistry.get(view);
    
    // 检查路由守卫
    if (routeConfig?.guards) {
      for (const guard of routeConfig.guards) {
        if (!guard(view, options)) {
          console.log(`路由守卫阻止导航到: ${view}`);
          return;
        }
      }
    }
    
    navigate(view, options);
  }, [navigate]);

  return {
    requireAuth,
    requirePermission,
    navigateWithGuard,
  };
};