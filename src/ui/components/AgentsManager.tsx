/**
 * AgentsManager - Subagent 配置管理器
 *
 * 交互式 UI,用于创建、编辑、删除 subagent 配置
 */

import { useMemoizedFn } from 'ahooks';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import fs from 'node:fs';
import { useMemo, useState } from 'react';
import { subagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type { SubagentConfig } from '../../agent/subagents/types.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';
import { AgentCreationWizard } from './AgentCreationWizard.js';

type ViewMode =
  | 'menu'
  | 'list'
  | 'create'
  | 'edit'
  | 'editWizard'
  | 'delete'
  | 'deleteConfirm';

export interface AgentsManagerProps {
  /** 初始视图模式 */
  initialMode?: ViewMode;
  /** 完成回调 */
  onComplete?: () => void;
  /** 取消回调 */
  onCancel?: () => void;
}

interface MenuItem {
  key?: string;
  label: string;
  value: string;
}

/**
 * Subagent 配置管理器主组件
 */
export function AgentsManager({
  initialMode = 'menu',
  onComplete,
  onCancel,
}: AgentsManagerProps) {
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [selectedAgent, setSelectedAgent] = useState<SubagentConfig | null>(null);
  const [refreshKey, setRefreshKey] = useState(0); // 用于触发重新加载

  // 重新加载 registry
  const reloadAgents = useMemoizedFn(() => {
    subagentRegistry.clear();
    subagentRegistry.loadFromStandardLocations();
    setRefreshKey((prev) => prev + 1); // 触发重新渲染
  });

  // 加载所有已配置的 agents (依赖 refreshKey 重新计算)
  const allAgents = useMemo(() => {
    return subagenctRegistry.getAllSubagents();
  }, [refreshKey]);

  // 主菜单选项
  const menuItems: MenuItem[] = [
    { key: 'list', label: '📋 查看所有 Agents', value: 'list' },
    { key: 'create', label: '➕ 创建新 Agent', value: 'create' },
    { key: 'edit', label: '✏️  编辑 Agent', value: 'edit' },
    { key: 'delete', label: '🗑️  删除 Agent', value: 'delete' },
    { key: 'cancel', label: '❌ 取消', value: 'cancel' },
  ];

  // 主菜单选择处理
  const handleMenuSelect = useMemoizedFn((item: MenuItem) => {
    if (item.value === 'cancel') {
      onCancel?.();
      return;
    }
    setMode(item.value as ViewMode);
  });

  // Agent 选择处理（编辑/删除）
  const handleAgentSelect = useMemoizedFn(
    (item: { label: string; value: SubagentConfig }) => {
      setSelectedAgent(item.value);
      // 根据当前模式决定下一步
      if (mode === 'edit') {
        setMode('editWizard');
      } else if (mode === 'delete') {
        setMode('deleteConfirm');
      }
    }
  );

  // 删除 Agent
  const handleDelete = useMemoizedFn(async () => {
    if (!selectedAgent?.configPath) {
      return;
    }

    try {
      // 删除配置文件
      await fs.promises.unlink(selectedAgent.configPath);
      // 重新加载 agents
      reloadAgents();
      // 返回主菜单
      backToMenu();
    } catch (error) {
      console.error('删除失败:', error);
    }
  });

  // 返回主菜单
  const backToMenu = useMemoizedFn(() => {
    setMode('menu');
    setSelectedAgent(null);
  });

  // 使用智能 Ctrl+C 处理（AgentsManager 没有执行中状态，直接退出）
  const handleCtrlC = useCtrlCHandler(false, onCancel);

  // ESC 键处理：返回上一步或取消
  // Ctrl+C 处理：智能退出
  // 注意：create 和 editWizard 模式下不拦截 ESC，让向导组件自己处理
  useInput(
    (input, key) => {
      if (key.escape) {
        if (mode === 'menu') {
          // 主菜单按 ESC 退出
          onCancel?.();
        } else if (mode === 'list' || mode === 'edit' || mode === 'delete') {
          // 列表/选择视图返回主菜单
          backToMenu();
        } else if (mode === 'deleteConfirm') {
          // 删除确认返回上一步
          backToMenu();
        }
        // create 和 editWizard 模式：不处理，让向导组件自己处理 ESC
      } else if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
      }
    },
    { isActive: mode !== 'create' && mode !== 'editWizard' }
  );

  // 主菜单视图
  if (mode === 'menu') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            📋 Agents 管理
          </Text>
        </Box>
        <SelectInput items={menuItems} onSelect={handleMenuSelect} />
        <Box marginTop={1}>
          <Text dimColor>使用方向键选择 | Enter 确认 | ESC 退出</Text>
        </Box>
      </Box>
    );
  }

  // 列表视图
  if (mode === 'list') {
    if (allAgents.length === 0) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">
              📋 所有 Agents
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color="gray">❌ 没有找到任何 agent 配置</Text>
          </Box>
          <Box marginTop={1} paddingLeft={2}>
            <Text color="gray">
              💡 配置文件位置: .blade/agents/ 或 ~/.blade/agents/
            </Text>
          </Box>
          <Box marginTop={1} paddingLeft={2}>
            <Text dimColor>按 ESC 返回菜单</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            📋 所有 Agents
          </Text>
          <Text color="gray"> (找到 {allAgents.length} 个)</Text>
        </Box>

        {allAgents.map((agent) => (
          <Box key={agent.name} flexDirection="column" paddingLeft={2}>
            <Box>
              <Text>
                <Text bold color={agent.color || 'white'}>
                  • {agent.name}
                </Text>
                <Text color="gray"> - {agent.description}</Text>
              </Text>
            </Box>
            {agent.tools && agent.tools.length > 0 && (
              <Box paddingLeft={2}>
                <Text color="gray">工具: {agent.tools.join(', ')}</Text>
              </Box>
            )}
            {agent.configPath && (
              <Box paddingLeft={2}>
                <Text color="gray" dimColor>
                  {agent.configPath}
                </Text>
              </Box>
            )}
          </Box>
        ))}

        <Box marginTop={1} paddingLeft={2}>
          <Text dimColor>按 ESC 返回菜单</Text>
        </Box>
      </Box>
    );
  }

  // Agent 选择器视图（编辑/删除共用）
  const renderAgentSelector = (title: string) => {
    if (allAgents.length === 0) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">
              {title}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color="gray">❌ 没有找到任何 agent 配置</Text>
          </Box>
          <Box marginTop={1} paddingLeft={2}>
            <Text dimColor>按 ESC 返回菜单</Text>
          </Box>
        </Box>
      );
    }

    const agentItems = allAgents.map((agent) => ({
      key: agent.name, // 显式指定 key 避免 React 警告
      label: `${agent.name} - ${agent.description}`,
      value: agent,
    }));

    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {title}
          </Text>
        </Box>
        <SelectInput items={agentItems} onSelect={handleAgentSelect} />
        <Box marginTop={1}>
          <Text dimColor>使用方向键选择 | Enter 确认 | ESC 返回</Text>
        </Box>
      </Box>
    );
  };

  // 创建视图
  if (mode === 'create') {
    return (
      <AgentCreationWizard
        onComplete={() => {
          reloadAgents(); // 重新加载 agents
          backToMenu(); // 返回主菜单,可以查看新创建的 agent
        }}
        onCancel={backToMenu}
      />
    );
  }

  // 编辑视图 - 选择要编辑的 Agent
  if (mode === 'edit') {
    return renderAgentSelector('✏️  编辑 Agent');
  }

  // 编辑向导 - 使用 AgentCreationWizard 编辑选中的 Agent
  if (mode === 'editWizard' && selectedAgent) {
    // 将 SubagentConfig 转换为 AgentConfig 格式
    const initialConfig = {
      name: selectedAgent.name,
      description: selectedAgent.description,
      tools: selectedAgent.tools || [],
      color: selectedAgent.color,
      location: selectedAgent.configPath?.includes('.blade/agents')
        ? ('project' as const)
        : ('user' as const),
      systemPrompt: selectedAgent.systemPrompt || '',
    };

    return (
      <AgentCreationWizard
        initialConfig={initialConfig}
        onComplete={() => {
          reloadAgents(); // 重新加载 agents
          backToMenu(); // 返回主菜单
        }}
        onCancel={backToMenu}
      />
    );
  }

  // 删除视图 - 选择要删除的 Agent
  if (mode === 'delete') {
    return renderAgentSelector('🗑️  删除 Agent');
  }

  // 删除确认 - 确认删除选中的 Agent
  if (mode === 'deleteConfirm' && selectedAgent) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="red">
            ⚠️ 确认删除
          </Text>
        </Box>
        <Box marginBottom={1} paddingLeft={2}>
          <Text>
            你确定要删除 Agent{' '}
            <Text bold color="yellow">
              {selectedAgent.name}
            </Text>{' '}
            吗？
          </Text>
        </Box>
        <Box marginBottom={1} paddingLeft={2}>
          <Text dimColor>文件路径: {selectedAgent.configPath}</Text>
        </Box>
        <Box marginBottom={1} paddingLeft={2}>
          <Text color="red">此操作无法撤销！</Text>
        </Box>
        <SelectInput
          items={[
            { label: '🗑️  确认删除', value: 'confirm' },
            { label: '❌ 取消', value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'confirm') {
              handleDelete();
            } else {
              backToMenu();
            }
          }}
        />
      </Box>
    );
  }

  return null;
}
