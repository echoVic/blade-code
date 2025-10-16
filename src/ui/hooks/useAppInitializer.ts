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
export const useAppInitializer = (
  addAssistantMessage: (message: string) => void,
  debug: boolean = false
) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('正在初始化...');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const { dispatch: appDispatch, actions: appActions } = useAppState();

  // 初始化应用
  const initializeApp = useMemoizedFn(async () => {
    try {
      setLoadingStatus('加载配置...');

      // 初始化配置管理器
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const config = configManager.getConfig();
      appDispatch(appActions.setConfig(config));
      appDispatch(appActions.setPermissionMode(config.permissionMode));

      setLoadingStatus('检查 API 密钥...');

      // 检查 API 密钥配置
      if (!config.apiKey || config.apiKey.trim() === '') {
        setHasApiKey(false);
        setShowSetupWizard(true); // 显示设置向导
        setIsInitialized(true);
        // 不再显示错误消息，向导会引导用户
        return;
      }

      setLoadingStatus('初始化完成!');
      setHasApiKey(true);
      setShowSetupWizard(false); // 关闭设置向导
      setIsInitialized(true);

      addAssistantMessage('Blade Code 助手已就绪！');
      addAssistantMessage('请输入您的问题，我将为您提供帮助。');

      console.log('Blade 应用初始化完成');
    } catch (error) {
      console.error('应用初始化失败:', error);
      const safeMessage = formatErrorMessage(error);
      addAssistantMessage(`❌ 初始化失败: ${safeMessage}`);
      setIsInitialized(true);
    }
  });

  // 应用初始化效果
  useEffect(() => {
    if (!isInitialized) {
      initializeApp();
    }
  }, [isInitialized, initializeApp]);

  // 设置完成回调（配置已保存，内存已更新，直接更新 UI 状态）
  const handleSetupComplete = useMemoizedFn(() => {
    // 验证配置是否真正保存成功
    const configManager = ConfigManager.getInstance();
    const config = configManager.getConfig();

    if (!config.apiKey || config.apiKey.trim() === '') {
      addAssistantMessage('❌ 配置验证失败：API 密钥未正确保存');
      addAssistantMessage('请重新尝试设置，或检查文件权限');
      setShowSetupWizard(true);
      return;
    }

    setHasApiKey(true);
    setShowSetupWizard(false);
    appDispatch(appActions.setConfig(config));
    appDispatch(appActions.setPermissionMode(config.permissionMode));
    addAssistantMessage('✅ 配置保存成功！');
    addAssistantMessage('Blade Code 助手已就绪！');
    addAssistantMessage('请输入您的问题，我将为您提供帮助。');
  });

  return {
    isInitialized,
    loadingStatus,
    hasApiKey,
    showSetupWizard,
    initializeApp,
    handleSetupComplete, // 新增
  };
};
