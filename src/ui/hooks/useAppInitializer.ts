import { useMemoizedFn } from 'ahooks';
import { useEffect, useState } from 'react';
import { ConfigService } from '../../config/ConfigService.js';

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

  // 初始化应用
  const initializeApp = useMemoizedFn(async () => {
    try {
      setLoadingStatus('加载配置...');

      // 初始化配置服务
      const configService = ConfigService.getInstance();
      await configService.initialize();
      const config = configService.getConfig();

      setLoadingStatus('检查 API 密钥...');

      // 检查 API 密钥配置
      if (!config.auth.apiKey || config.auth.apiKey.trim() === '') {
        setHasApiKey(false);
        setIsInitialized(true);
        addAssistantMessage('🚀 欢迎使用 Blade AI 助手！');
        addAssistantMessage('/help for help, /status for your current setup');
        addAssistantMessage(`Cwd: ${process.cwd()}`);
        addAssistantMessage(
          '⚠️  API Key 未配置\n\nAPI Base URL: https://apis.iflow.cn\n\n📋 配置步骤:\n1. 设置环境变量: export BLADE_API_KEY="your-api-key"\n2. 重新启动 Blade\n\n💡 或者使用命令行参数: blade --api-key="your-api-key"'
        );
        return;
      }

      setLoadingStatus('初始化完成!');
      setHasApiKey(true);
      setIsInitialized(true);

      addAssistantMessage('🚀 Blade AI 助手已就绪！');
      addAssistantMessage('请输入您的问题，我将为您提供帮助。');

      console.log('Blade 应用初始化完成');
    } catch (error) {
      console.error('应用初始化失败:', error);
      addAssistantMessage(`❌ 初始化失败: ${error}`);
      setIsInitialized(true);
    }
  });

  // 应用初始化效果
  useEffect(() => {
    if (!isInitialized) {
      initializeApp();
    }
  }, [isInitialized, initializeApp]);

  return {
    isInitialized,
    loadingStatus,
    hasApiKey,
    initializeApp,
  };
};
