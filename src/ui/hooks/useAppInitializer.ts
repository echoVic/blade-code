import { useMemoizedFn } from 'ahooks';
import { useEffect, useState } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import { useAppState } from '../contexts/AppContext.js';

/**
 * 格式化错误消息，移除敏感信息
 */
function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // 移除可能包含 API Key 的内容
  return message
    .replace(/sk-[a-zA-Z0-9]{32,}/g, 'sk-***')
    .replace(/apiKey['":\s]+[a-zA-Z0-9-_]+/gi, 'apiKey: ***')
    .replace(/API_KEY['":\s=]+[a-zA-Z0-9-_]+/gi, 'API_KEY=***');
}

/**
 * 应用初始化 Hook
 * 负责应用的初始化逻辑、配置加载和API密钥检查
 */
type InitializationStatus = 'idle' | 'loading' | 'ready' | 'needsSetup' | 'error';

interface UseAppInitializerOptions {
  debug?: boolean;
}

interface InitializationResult {
  status: InitializationStatus;
  readyForChat: boolean;
  requiresSetup: boolean;
  errorMessage: string | null;
  initializeApp: () => Promise<void>;
  handleSetupComplete: () => void;
}

/**
 * 应用初始化 Hook
 * 负责加载配置、检查 API Key 并同步应用上下文
 */
export const useAppInitializer = (
  options: UseAppInitializerOptions = {}
): InitializationResult => {
  const { debug = false } = options;
  const [status, setStatus] = useState<InitializationStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { dispatch: appDispatch, actions: appActions } = useAppState();

  // 初始化应用
  const initializeApp = useMemoizedFn(async () => {
    if (debug) {
      console.log('[Debug] 初始化流程开始');
    }

    setStatus('loading');
    setErrorMessage(null);

    try {
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const config = configManager.getConfig();

      appDispatch(appActions.setConfig(config));
      appDispatch(appActions.setPermissionMode(config.permissionMode));

      if (!config.apiKey || config.apiKey.trim() === '') {
        if (debug) {
          console.log('[Debug] 未检测到 API Key，进入设置向导');
        }
        setStatus('needsSetup');
        return;
      }

      if (debug) {
        console.log('[Debug] 初始化完成，准备就绪');
      }
      setStatus('ready');
    } catch (error) {
      const safeMessage = formatErrorMessage(error);

      if (debug) {
        console.log('[Debug] 初始化失败:', safeMessage);
      }

      setErrorMessage(safeMessage);
      setStatus('error');
    }
  });

  // 应用初始化效果
  useEffect(() => {
    if (status === 'idle') {
      initializeApp();
    }
  }, [status, initializeApp]);

  // 设置完成回调（配置已保存，内存已更新，直接更新 UI 状态）
  const handleSetupComplete = useMemoizedFn(() => {
    const configManager = ConfigManager.getInstance();
    const config = configManager.getConfig();

    if (!config.apiKey || config.apiKey.trim() === '') {
      setErrorMessage('配置验证失败：API 密钥未正确保存');
      setStatus('needsSetup');
      return;
    }

    appDispatch(appActions.setConfig(config));
    appDispatch(appActions.setPermissionMode(config.permissionMode));
    setErrorMessage(null);
    setStatus('ready');

    if (debug) {
      console.log('[Debug] 配置保存成功，系统已就绪');
    }
  });

  return {
    status,
    readyForChat: status === 'ready',
    requiresSetup: status === 'needsSetup',
    errorMessage,
    initializeApp,
    handleSetupComplete,
  };
};
