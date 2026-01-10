/**
 * Hooks 管理器 UI 组件
 *
 * 提供交互式界面来添加、查看和管理 hooks 配置
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useState } from 'react';
import { HookManager } from '../../hooks/HookManager.js';
import {
  type CommandHook,
  HookEvent,
  type HookMatcher,
} from '../../hooks/types/HookTypes.js';
import { themeManager } from '../themes/ThemeManager.js';

interface HooksManagerProps {
  onClose: () => void;
  onSave?: (hook: NewHookData) => void;
}

interface NewHookData {
  event: HookEvent;
  matcher: string;
  command: string;
}

type Step = 'action' | 'event' | 'matcher' | 'command' | 'location' | 'confirm';

type ActionType = 'add' | 'status' | 'list';

type SaveLocation = 'local' | 'project' | 'user';

const ACTIONS: Array<{ action: ActionType; description: string }> = [
  { action: 'add', description: 'Add a new hook' },
  { action: 'status', description: 'Show hooks status' },
  { action: 'list', description: 'List all configured hooks' },
];

const SAVE_LOCATIONS: Array<{
  location: SaveLocation;
  name: string;
  description: string;
}> = [
  {
    location: 'local',
    name: 'Project settings (local)',
    description: 'Saved in .blade/settings.local.json',
  },
  {
    location: 'project',
    name: 'Project settings',
    description: 'Checked in at .blade/settings.json',
  },
  {
    location: 'user',
    name: 'User settings',
    description: 'Saved in at ~/.blade/settings.json',
  },
];

const HOOK_EVENTS = [
  { event: HookEvent.PreToolUse, description: 'Before tool execution' },
  { event: HookEvent.PostToolUse, description: 'After tool execution' },
  { event: HookEvent.PostToolUseFailure, description: 'After tool execution fails' },
  { event: HookEvent.PermissionRequest, description: 'When permission is requested' },
  { event: HookEvent.UserPromptSubmit, description: 'Before processing user prompt' },
  { event: HookEvent.Stop, description: 'When Claude stops responding' },
  { event: HookEvent.SubagentStop, description: 'When subagent stops' },
  { event: HookEvent.SessionStart, description: 'When session starts' },
  { event: HookEvent.SessionEnd, description: 'When session ends' },
  { event: HookEvent.Notification, description: 'When notification is sent' },
  { event: HookEvent.Compaction, description: 'Before context compaction' },
];

const COMMAND_EXAMPLES = [
  'jq -r \'.tool_input.file_path | select(endswith(".go"))\' | xargs -r gofmt -w',
  'jq -r \'"\\(.tool_input.command) - \\(.tool_input.description // "No description")"\' >> ~/.blade/bash-command-log.txt',
  '/usr/local/bin/security_check.sh',
  'python3 ~/hooks/validate_changes.py',
];

export const HooksManager: React.FC<HooksManagerProps> = ({ onClose, onSave }) => {
  const theme = themeManager.getTheme();
  const [step, setStep] = useState<Step>('action');
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);
  const [selectedLocationIndex, setSelectedLocationIndex] = useState(0);
  const [matcher, setMatcher] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const _selectedAction = ACTIONS[selectedActionIndex];
  const selectedEvent = HOOK_EVENTS[selectedEventIndex];
  const selectedLocation = SAVE_LOCATIONS[selectedLocationIndex];

  // 返回上一步
  const goBack = () => {
    // 如果有 statusMessage，先清除它
    if (statusMessage) {
      setStatusMessage(null);
      return;
    }

    switch (step) {
      case 'action':
        onClose(); // 第一步时关闭界面
        break;
      case 'event':
        setStep('action');
        break;
      case 'matcher':
        setStep('event');
        break;
      case 'command':
        setStep('matcher');
        break;
      case 'location':
        setStep('command');
        break;
      case 'confirm':
        setStep('location');
        break;
    }
  };

  // 处理键盘输入
  useInput((input, key) => {
    if (key.escape) {
      goBack();
      return;
    }

    if (step === 'action') {
      if (key.upArrow) {
        setSelectedActionIndex((prev) => (prev > 0 ? prev - 1 : ACTIONS.length - 1));
      } else if (key.downArrow) {
        setSelectedActionIndex((prev) => (prev < ACTIONS.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        handleActionSelect();
      }
    } else if (step === 'event') {
      if (key.upArrow) {
        setSelectedEventIndex((prev) => (prev > 0 ? prev - 1 : HOOK_EVENTS.length - 1));
      } else if (key.downArrow) {
        setSelectedEventIndex((prev) => (prev < HOOK_EVENTS.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        setStep('matcher');
      }
    } else if (step === 'location') {
      if (key.upArrow) {
        setSelectedLocationIndex((prev) =>
          prev > 0 ? prev - 1 : SAVE_LOCATIONS.length - 1
        );
      } else if (key.downArrow) {
        setSelectedLocationIndex((prev) =>
          prev < SAVE_LOCATIONS.length - 1 ? prev + 1 : 0
        );
      } else if (key.return) {
        setStep('confirm');
      }
    } else if (step === 'confirm') {
      if (key.return) {
        handleSave();
      }
    }
  });

  // 处理 action 选择
  const handleActionSelect = () => {
    const action = ACTIONS[selectedActionIndex].action;
    if (action === 'add') {
      setStep('event');
    } else if (action === 'status') {
      showStatus();
    } else if (action === 'list') {
      showList();
    }
  };

  // 显示 hooks 状态
  const showStatus = () => {
    const hookManager = HookManager.getInstance();
    const isEnabled = hookManager.isEnabled();
    const config = hookManager.getConfig();

    // 统计各类型配置的 hooks 数量
    const hookCounts: Record<string, number> = {};
    for (const event of Object.values(HookEvent)) {
      const matchers = config[event];
      if (matchers && Array.isArray(matchers)) {
        const totalHooks = matchers.reduce((sum, m) => sum + (m.hooks?.length || 0), 0);
        if (totalHooks > 0) {
          hookCounts[event] = totalHooks;
        }
      }
    }

    const lines: string[] = [`Status: ${isEnabled ? '✅ Enabled' : '⏸️ Disabled'}`, ''];

    if (Object.keys(hookCounts).length > 0) {
      lines.push('Configured hooks:');
      for (const [event, count] of Object.entries(hookCounts)) {
        lines.push(`  ${event}: ${count} hook(s)`);
      }
    } else {
      lines.push('No hooks configured');
    }

    setStatusMessage(lines.join('\n'));
  };

  // 显示 hooks 列表
  const showList = () => {
    const hookManager = HookManager.getInstance();
    const config = hookManager.getConfig();
    const lines: string[] = [];

    let hasAnyHooks = false;

    for (const event of Object.values(HookEvent)) {
      const matchers = config[event];
      if (!matchers || !Array.isArray(matchers) || matchers.length === 0) {
        continue;
      }

      hasAnyHooks = true;
      lines.push(`${event}:`);

      for (const matcher of matchers) {
        const matcherConfig = matcher.matcher;
        let matcherDesc = 'all';
        if (matcherConfig?.tools) {
          const tools = Array.isArray(matcherConfig.tools)
            ? matcherConfig.tools.join(', ')
            : matcherConfig.tools;
          matcherDesc = `tools: ${tools}`;
        }
        lines.push(`  [${matcherDesc}]`);
        for (const hook of matcher.hooks || []) {
          if (hook.type === 'command') {
            lines.push(`    → ${hook.command}`);
          }
        }
      }
      lines.push('');
    }

    if (!hasAnyHooks) {
      lines.push('No hooks configured');
      lines.push('');
      lines.push('Configure hooks in .blade/settings.local.json');
    }

    setStatusMessage(lines.join('\n'));
  };

  const handleMatcherSubmit = () => {
    setStep('command');
  };

  const handleCommandSubmit = () => {
    if (!command.trim()) {
      setError('Command cannot be empty');
      return;
    }
    setError(null);
    setStep('location');
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const hookManager = HookManager.getInstance();
      const fs = await import('node:fs/promises');
      const pathModule = await import('node:path');
      const os = await import('node:os');

      // 构建新的 hook matcher
      const newMatcher: HookMatcher = {
        matcher: matcher.trim() ? { tools: matcher.trim() } : {},
        hooks: [
          {
            type: 'command',
            command: command.trim(),
          } as CommandHook,
        ],
      };

      // 根据选择的位置确定配置文件路径
      let settingsPath: string;
      switch (selectedLocation.location) {
        case 'local':
          settingsPath = pathModule.join(
            process.cwd(),
            '.blade',
            'settings.local.json'
          );
          break;
        case 'project':
          settingsPath = pathModule.join(process.cwd(), '.blade', 'settings.json');
          break;
        case 'user':
          settingsPath = pathModule.join(os.homedir(), '.blade', 'settings.json');
          break;
      }

      // 确保目录存在
      await fs.mkdir(pathModule.dirname(settingsPath), { recursive: true });

      // 读取现有配置
      let settings: Record<string, unknown> = {};
      try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      } catch {
        // 文件不存在，使用空对象
      }

      // 获取现有 hooks 配置
      const existingHooks = (settings.hooks as Record<string, unknown>) || {};
      const existingMatchers =
        (existingHooks[selectedEvent.event] as HookMatcher[]) || [];

      // 构造合并后的 hooks 配置
      const updatedHooks = {
        ...existingHooks,
        enabled: true,
        [selectedEvent.event]: [...existingMatchers, newMatcher],
      };

      // 写入配置文件
      settings.hooks = updatedHooks;
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      // 重新加载 HookManager 配置
      await hookManager.reloadConfig();

      // 通知保存成功
      if (onSave) {
        onSave({
          event: selectedEvent.event,
          matcher: matcher.trim(),
          command: command.trim(),
        });
      }

      onClose();
    } catch (err) {
      setError(
        `Failed to save hook: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      setSaving(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color={theme.colors.success}>
          Hooks Manager
        </Text>
      </Box>

      {/* 警告信息 */}
      <Box marginBottom={1}>
        <Text color={theme.colors.warning}>
          ⚠ Hooks execute shell commands with your full user permissions. Only use hooks
          from trusted sources.
        </Text>
      </Box>

      {/* 状态/列表消息显示 */}
      {statusMessage && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{statusMessage}</Text>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>Esc to go back</Text>
          </Box>
        </Box>
      )}

      {/* Action 选择 */}
      {step === 'action' && !statusMessage && (
        <Box flexDirection="column">
          <Box flexDirection="column" marginTop={1}>
            {ACTIONS.map((item, index) => (
              <Box key={item.action}>
                <Text
                  color={
                    index === selectedActionIndex ? theme.colors.primary : undefined
                  }
                  bold={index === selectedActionIndex}
                >
                  {index === selectedActionIndex ? '❯ ' : '  '}
                  {item.action}
                </Text>
                <Text color={theme.colors.muted}> - {item.description}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              ↑/↓ to select · Enter to continue · Esc to close
            </Text>
          </Box>
        </Box>
      )}

      {/* 事件选择 */}
      {step === 'event' && (
        <Box flexDirection="column">
          <Text bold>Select Event:</Text>
          <Box flexDirection="column" marginTop={1}>
            {HOOK_EVENTS.map((item, index) => (
              <Box key={item.event}>
                <Text
                  color={
                    index === selectedEventIndex ? theme.colors.primary : undefined
                  }
                  bold={index === selectedEventIndex}
                >
                  {index === selectedEventIndex ? '❯ ' : '  '}
                  {item.event}
                </Text>
                <Text color={theme.colors.muted}> - {item.description}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              ↑/↓ to select · Enter to continue · Esc to go back
            </Text>
          </Box>
        </Box>
      )}

      {/* 显示已选事件 */}
      {step !== 'event' && (
        <Box marginBottom={1}>
          <Text>
            Event:{' '}
            <Text bold color={theme.colors.primary}>
              {selectedEvent.event}
            </Text>
            <Text color={theme.colors.muted}> - {selectedEvent.description}</Text>
          </Text>
        </Box>
      )}

      {/* 退出码说明 */}
      {(step === 'matcher' || step === 'command' || step === 'confirm') && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.colors.muted}>
            Input to command is JSON of tool call arguments.
          </Text>
          <Text color={theme.colors.muted}>Exit code 0 - stdout/stderr not shown</Text>
          <Text color={theme.colors.muted}>
            Exit code 2 - show stderr to model and block tool call
          </Text>
          <Text color={theme.colors.muted}>
            Other exit codes - show stderr to user only but continue with tool call
          </Text>
        </Box>
      )}

      {/* Matcher 输入 */}
      {step === 'matcher' && (
        <Box flexDirection="column">
          <Box>
            <Text bold>Matcher: </Text>
            <TextInput
              value={matcher}
              onChange={setMatcher}
              onSubmit={handleMatcherSubmit}
              placeholder="e.g., Read, Bash, Edit|Write (empty = all tools)"
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              Tool name pattern (supports | for multiple). Leave empty to match all.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>Enter to continue · Esc to go back</Text>
          </Box>
        </Box>
      )}

      {/* 显示已输入的 Matcher */}
      {(step === 'command' || step === 'confirm') && (
        <Box marginBottom={1}>
          <Text>
            Matcher: <Text bold>{matcher || '(all tools)'}</Text>
          </Text>
        </Box>
      )}

      {/* Command 输入 */}
      {step === 'command' && (
        <Box flexDirection="column">
          <Box>
            <Text bold>Command: </Text>
          </Box>
          <Box
            borderStyle="single"
            borderColor={theme.colors.border.light}
            paddingX={1}
            marginTop={1}
          >
            <TextInput
              value={command}
              onChange={setCommand}
              onSubmit={handleCommandSubmit}
              placeholder="Enter shell command..."
            />
          </Box>

          {/* 示例 */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Examples:</Text>
            {COMMAND_EXAMPLES.map((example, index) => (
              <Text key={index} color={theme.colors.muted}>
                • {example}
              </Text>
            ))}
          </Box>

          <Box marginTop={1}>
            <Text color={theme.colors.muted}>Enter to continue · Esc to go back</Text>
          </Box>
        </Box>
      )}

      {/* 保存位置选择 */}
      {step === 'location' && (
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.colors.border.light}
            paddingX={2}
            paddingY={1}
            marginBottom={1}
          >
            <Text bold color={theme.colors.primary}>
              Save hook configuration
            </Text>
            <Text> </Text>
            <Text>
              {' '}
              Event: {selectedEvent.event} - {selectedEvent.description}
            </Text>
            <Text> Matcher: {matcher || '(all)'}</Text>
            <Text> Command: {command}</Text>
          </Box>

          <Text bold>Where should this hook be saved?</Text>
          <Box flexDirection="column" marginTop={1}>
            {SAVE_LOCATIONS.map((item, index) => (
              <Box key={item.location}>
                <Text
                  color={
                    index === selectedLocationIndex ? theme.colors.primary : undefined
                  }
                  bold={index === selectedLocationIndex}
                >
                  {index === selectedLocationIndex ? '❯ ' : '  '}
                  {index + 1}. {item.name}
                </Text>
                <Text color={theme.colors.muted}> {item.description}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>Enter to confirm · Esc to go back</Text>
          </Box>
        </Box>
      )}

      {/* 确认 */}
      {step === 'confirm' && (
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.colors.success}
            paddingX={2}
            paddingY={1}
          >
            <Text bold>Saving hook to {selectedLocation.description}...</Text>
            <Text> </Text>
            <Text>Event: {selectedEvent.event}</Text>
            <Text>Matcher: {matcher || '(all tools)'}</Text>
            <Text>Command: {command}</Text>
          </Box>

          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              {saving ? 'Saving...' : 'Enter to confirm · Esc to go back'}
            </Text>
          </Box>
        </Box>
      )}

      {/* 错误信息 */}
      {error && (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>❌ {error}</Text>
        </Box>
      )}
    </Box>
  );
};
