import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { useAppState } from '../contexts/AppContext.js';
import type { AppView } from '../hooks/useAppNavigation.js';

interface Command {
  id: string;
  name: string;
  description: string;
  category: string;
  targetView: AppView;
  icon: string;
  shortcut?: string;
  keywords: string[];
}

interface CommandPaletteProps {
  onClose: () => void;
  onSelectCommand: (command: Command) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ 
  onClose, 
  onSelectCommand 
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { state } = useAppState();

  // 预定义命令列表
  const commands: Command[] = [
    {
      id: 'main',
      name: '主界面',
      description: '返回主界面',
      category: '导航',
      targetView: 'main' as AppView,
      icon: '🏠',
      keywords: ['home', 'main', '主界面', '首页'],
    },
    {
      id: 'settings',
      name: '设置',
      description: '打开设置面板',
      category: '导航',
      targetView: 'settings' as AppView,
      icon: '⚙️',
      shortcut: 'Ctrl+S',
      keywords: ['settings', 'config', '设置', '配置'],
    },
    {
      id: 'help',
      name: '帮助',
      description: '查看帮助文档',
      category: '导航',
      targetView: 'help' as AppView,
      icon: '❓',
      shortcut: 'Ctrl+H',
      keywords: ['help', '文档', '帮助', '文档'],
    },
    {
      id: 'logs',
      name: '日志',
      description: '查看应用日志',
      category: '导航',
      targetView: 'logs' as AppView,
      icon: '📝',
      shortcut: 'Ctrl+L',
      keywords: ['logs', '日志', '记录'],
    },
    {
      id: 'tools',
      name: '工具',
      description: '访问工具面板',
      category: '导航',
      targetView: 'tools' as AppView,
      icon: '🔨',
      shortcut: 'Ctrl+T',
      keywords: ['tools', '工具', '实用工具'],
    },
    {
      id: 'chat',
      name: '聊天',
      description: '与AI助手对话',
      category: '导航',
      targetView: 'chat' as AppView,
      icon: '💬',
      shortcut: 'Ctrl+C',
      keywords: ['chat', '聊天', '对话', 'ai'],
    },
    {
      id: 'config',
      name: '配置',
      description: '管理应用配置',
      category: '导航',
      targetView: 'config' as AppView,
      icon: '🛠️',
      keywords: ['config', '配置', '管理'],
    },
    // 工具相关命令
    {
      id: 'git-status',
      name: 'Git状态',
      description: '查看Git仓库状态',
      category: '工具',
      targetView: 'tools' as AppView,
      icon: '📊',
      keywords: ['git', 'status', '状态'],
    },
    {
      id: 'file-explorer',
      name: '文件浏览器',
      description: '浏览项目文件',
      category: '工具',
      targetView: 'tools' as AppView,
      icon: '📁',
      keywords: ['file', '文件', '浏览器'],
    },
    // 设置相关命令
    {
      id: 'theme-settings',
      name: '主题设置',
      description: '更改应用主题',
      category: '设置',
      targetView: 'settings' as AppView,
      icon: '🎨',
      keywords: ['theme', '主题', '外观'],
    },
    {
      id: 'language-settings',
      name: '语言设置',
      description: '更改界面语言',
      category: '设置',
      targetView: 'settings' as AppView,
      icon: '🌐',
      keywords: ['language', '语言', '本地化'],
    },
  ];

  // 过滤命令
  const filteredCommands = commands.filter(command => {
    if (!searchTerm) return true;
    
    const term = searchTerm.toLowerCase();
    return (
      command.name.toLowerCase().includes(term) ||
      command.description.toLowerCase().includes(term) ||
      command.keywords.some(keyword => keyword.toLowerCase().includes(term)) ||
      command.category.toLowerCase().includes(term)
    );
  });

  // 处理键盘输入
  useInput((input, key) => {
    // ESC键关闭
    if (key.escape) {
      onClose();
      return;
    }

    // 回车键选择
    if (key.return) {
      if (filteredCommands.length > 0) {
        onSelectCommand(filteredCommands[selectedIndex]);
      }
      return;
    }

    // 上下箭头导航
    if (key.upArrow) {
      setSelectedIndex(prev => 
        prev > 0 ? prev - 1 : filteredCommands.length - 1
      );
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => 
        prev < filteredCommands.length - 1 ? prev + 1 : 0
      );
      return;
    }

    // 输入字符
    if (input && input.length === 1) {
      setSearchTerm(prev => prev + input);
      setSelectedIndex(0); // 重置选择索引
      return;
    }

    // 退格键
    if (key.backspace) {
      setSearchTerm(prev => prev.slice(0, -1));
      setSelectedIndex(0); // 重置选择索引
      return;
    }
  });

  // 重置搜索 when reopening
  useEffect(() => {
    setSearchTerm('');
    setSelectedIndex(0);
  }, []);

  // 按类别分组命令
  const groupedCommands = filteredCommands.reduce((acc, command) => {
    if (!acc[command.category]) {
      acc[command.category] = [];
    }
    acc[command.category].push(command);
    return acc;
  }, {} as Record<string, Command[]>);

  return (
    <Box 
      flexDirection="column"
      position="absolute"
      top="20%"
      left="20%"
      width="60%"
      height="60%"
      borderStyle="round"
      borderColor="#4F46E5"
      backgroundColor="#1F2937"
      padding={1}
      zIndex={100}
    >
      {/* 标题 */}
      <Box 
        flexDirection="row" 
        justifyContent="space-between" 
        marginBottom={1}
        paddingBottom={1}
        borderBottomColor="#374151"
        borderBottomStyle="single"
      >
        <Text color="#93C5FD" bold>
          💡 命令面板
        </Text>
        <Text color="#9CA3AF" dimColor>
          ESC 关闭
        </Text>
      </Box>

      {/* 搜索框 */}
      <Box 
        flexDirection="row" 
        alignItems="center"
        paddingX={1}
        paddingY={0}
        marginBottom={1}
        backgroundColor="#374151"
        height={1}
      >
        <Text color="#9CA3AF">🔍</Text>
        <Text color="#D1D5DB" marginLeft={1}>
          {searchTerm || '输入命令或关键词...'}
        </Text>
      </Box>

      {/* 命令列表 */}
      <Box flexDirection="column" flexGrow={1}>
        {Object.entries(groupedCommands).map(([category, cmds]) => (
          <Box key={category} flexDirection="column" marginBottom={1}>
            <Text color="#93C5FD" bold marginBottom={1}>
              {category}
            </Text>
            {cmds.map((command, index) => {
              const isSelected = selectedIndex === filteredCommands.indexOf(command);
              return (
                <Box
                  key={command.id}
                  flexDirection="row"
                  alignItems="center"
                  paddingX={1}
                  paddingY={0}
                  height={1}
                  backgroundColor={isSelected ? '#4F46E5' : 'transparent'}
                  marginBottom={0}
                >
                  <Text color={isSelected ? '#FFFFFF' : '#FBBF24'} marginRight={1}>
                    {command.icon}
                  </Text>
                  <Text 
                    color={isSelected ? '#FFFFFF' : '#D1D5DB'} 
                    bold={isSelected}
                    width={15}
                  >
                    {command.name}
                  </Text>
                  <Text 
                    color={isSelected ? '#E5E7EB' : '#9CA3AF'} 
                    dimColor={!isSelected}
                    marginLeft={2}
                  >
                    {command.description}
                  </Text>
                  {command.shortcut && (
                    <Text 
                      color={isSelected ? '#BFDBFE' : '#6B7280'} 
                      marginLeft={2}
                      dimColor={!isSelected}
                    >
                      {command.shortcut}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}

        {filteredCommands.length === 0 && (
          <Box 
            flexDirection="column" 
            alignItems="center" 
            justifyContent="center" 
            flexGrow={1}
          >
            <Text color="#9CA3AF">未找到匹配的命令</Text>
            <Text color="#6B7280" dimColor marginTop={1}>
              请尝试其他关键词
            </Text>
          </Box>
        )}
      </Box>

      {/* 底部提示 */}
      <Box 
        flexDirection="row" 
        justifyContent="space-between" 
        marginTop={1}
        paddingTop={1}
        borderTopColor="#374151"
        borderTopStyle="single"
      >
        <Text color="#9CA3AF" dimColor>
          ↑↓ 导航  ↵ 选择
        </Text>
        <Text color="#9CA3AF" dimColor>
          {filteredCommands.length} 个命令
        </Text>
      </Box>
    </Box>
  );
};