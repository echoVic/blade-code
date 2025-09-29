import { Box, Text } from 'ink';
import React from 'react';
import type { AppView } from '../hooks/useAppNavigation.js';

// 简单的视图组件
const SimpleView: React.FC<{ title: string }> = ({ title }) => (
  <Box flexDirection="column" padding={1}>
    <Text color="blue">{title}</Text>
    <Text>功能正在开发中...</Text>
  </Box>
);

const MainView = () => <SimpleView title="主界面" />;
const SettingsView = () => <SimpleView title="设置" />;
const HelpView = () => <SimpleView title="帮助" />;
const LogsView = () => <SimpleView title="日志" />;
const ToolsView = () => <SimpleView title="工具" />;
const ChatView = () => <SimpleView title="聊天" />;
const ConfigView = () => <SimpleView title="配置" />;

interface MainLayoutProps {
  currentView: AppView;
  children?: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ currentView, children }) => {
  const renderCurrentView = () => {
    switch (currentView) {
      case 'main':
        return <MainView />;
      case 'settings':
        return <SettingsView />;
      case 'help':
        return <HelpView />;
      case 'logs':
        return <LogsView />;
      case 'tools':
        return <ToolsView />;
      case 'chat':
        return <ChatView />;
      case 'config':
        return <ConfigView />;
      default:
        return <MainView />;
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={0}>
      {children || renderCurrentView()}
    </Box>
  );
};
