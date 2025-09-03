import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { CommandPalette } from './components/CommandPalette.js';
import { MainLayout } from './components/MainLayout.js';
import { NotificationSystem } from './components/NotificationSystem.js';
import { PerformanceMonitor } from './components/PerformanceMonitor.js';
import { SplashScreen } from './components/SplashScreen.js';
import { StatusBar } from './components/StatusBar.js';
import { ConfigManager } from './config/config-manager.js';
import { BladeConfig } from './config/types.js';
import { useAppState } from './contexts/AppContext.js';
import { useAppNavigation } from './hooks/useAppNavigation.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { PerformanceProvider } from './ui/ink/PerformanceOptimizer.js';
import { ResponsiveProvider } from './ui/ink/ResponsiveAdapter.js';
import { ThemeProvider } from './ui/ink/ThemeAdapter.js';
import { SessionProvider, useSession } from './contexts/SessionContext.js';
// import { useTheme } from './ui/themes/theme-manager.js';

interface AppProps {
  config?: BladeConfig;
  debug?: boolean;
  testMode?: boolean;
}

export const BladeApp: React.FC<AppProps> = ({ 
  config, 
  debug = false, 
  testMode = false 
}) => {
  const [showSplash, setShowSplash] = useState(true);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingStatus, setLoadingStatus] = useState('正在初始化...');
  
  const { exit } = useApp();
  // const theme = useTheme();
  const { state, dispatch } = useAppState();
  const { navigate, currentView } = useAppNavigation();
  const { state: sessionState, addUserMessage, addAssistantMessage } = useSession();

  // 初始化应用
  const initializeApp = useCallback(async () => {
    try {
      setLoadingStatus('加载配置...');
      setLoadingProgress(10);

      // 初始化配置管理器
      const configManager = ConfigManager.getInstance();
      await configManager.initialize(config);

      setLoadingStatus('初始化系统...');
      setLoadingProgress(30);

      // 初始化系统组件
      // 暂时省略具体的初始化逻辑

      setLoadingStatus('完成初始化...');
      setLoadingProgress(100);

      setIsInitialized(true);
      
      // 短暂显示启动画面
      setTimeout(() => {
        setShowSplash(false);
      }, debug ? 1000 : 3000);

      console.log('Blade 应用初始化完成');
    } catch (error) {
      console.error('应用初始化失败:', error);
      exit();
    }
  }, [config, debug, exit]);

  // 键盘快捷键处理
  useKeyboardShortcuts([
    {
      key: 'P',
      ctrl: true,
      description: '打开命令面板',
      category: 'navigation',
      action: () => setShowCommandPalette(prev => !prev)
    },
    {
      key: 'S',
      ctrl: true,
      description: '打开设置',
      category: 'navigation',
      action: () => navigate('settings' as any)
    },
    {
      key: 'H',
      ctrl: true,
      description: '打开帮助',
      category: 'navigation',
      action: () => navigate('help' as any)
    },
    {
      key: 'Q',
      ctrl: true,
      description: '退出应用',
      category: 'system',
      action: () => {
        exit();
      }
    },
    {
      key: 'Escape',
      description: '关闭面板或返回主界面',
      category: 'navigation',
      action: () => {
        if (showCommandPalette) {
          setShowCommandPalette(false);
        } else if (currentView !== 'main') {
          navigate('main' as any);
        }
      }
    },
    {
      key: 'L',
      ctrl: true,
      description: '打开日志',
      category: 'navigation',
      action: () => navigate('logs' as any)
    },
    {
      key: 'T',
      ctrl: true,
      description: '打开工具',
      category: 'navigation',
      action: () => navigate('tools' as any)
    },
    {
      key: 'C',
      ctrl: true,
      description: '打开聊天',
      category: 'navigation',
      action: () => navigate('chat' as any)
    }
  ]);

  // 应用初始化
  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  // 应用状态更新
  useEffect(() => {
    if (isInitialized) {
      dispatch({
        type: 'SET_INITIALIZED',
        payload: isInitialized
      });
    }
  }, [isInitialized, dispatch]);

  if (showSplash) {
    return (
      <SplashScreen 
        progress={loadingProgress}
        status={loadingStatus}
        debug={debug}
      />
    );
  }

  if (!isInitialized) {
    return (
      <Box flexDirection="column" justifyContent="center" alignItems="center">
        <Text color="yellow">⏳ 正在初始化应用...</Text>
      </Box>
    );
  }

  return (
    <ResponsiveProvider>
      <PerformanceProvider>
        <ThemeProvider>
          <Box flexDirection="column" height="100%">
            <MainLayout currentView={currentView}>
              {/* 主要内容区域将由MainLayout渲染 */}
            </MainLayout>
            
            {/* 状态栏 */}
            <StatusBar 
              currentView={currentView}
              performanceStats={undefined}
            />
            
            {/* 命令面板 */}
            {showCommandPalette && (
              <CommandPalette 
                onClose={() => setShowCommandPalette(false)}
                onSelectCommand={(command) => {
                  setShowCommandPalette(false);
                  navigate(command.targetView as any);
                }}
              />
            )}
            
            {/* 通知系统 */}
            <NotificationSystem position="top-right" />
            
            {/* 性能监控器 (仅在调试模式显示) */}
            {debug && <PerformanceMonitor />}
            
            {/* 测试模式标识 */}
            {testMode && (
              <Box position="absolute">
                <Text backgroundColor="red" color="white"> TEST MODE </Text>
              </Box>
            )}
          </Box>
        </ThemeProvider>
      </PerformanceProvider>
    </ResponsiveProvider>
  );
};

// 主导出函数
export const runBladeApp = (props: AppProps = {}): void => {
  const { config, debug = false, testMode = false } = props;
  
  try {
    // 这里应该是渲染逻辑，但为了简化，我们只输出日志
    console.log('Blade 应用启动:', { config, debug, testMode });
  } catch (error) {
    console.error('启动应用失败:', error);
    process.exit(1);
  }
};

export default BladeApp;