import { Box, Text, useInput, useStdout } from 'ink';
import SelectInput, { type ItemProps as SelectItemProps } from 'ink-select-input';
import React, { useMemo } from 'react';
import { PermissionMode } from '../../config/types.js';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';
import { MessageRenderer } from './MessageRenderer.js';

const ConfirmationItem = React.memo(({ label, isSelected }: SelectItemProps) => (
  <Text color={isSelected ? 'yellow' : undefined}>{label}</Text>
));

/**
 * 确认详情内容组件（静态内容，memo 化避免闪烁）
 * 将不随 SelectInput 状态变化的内容隔离，防止按键时整个组件重新渲染
 */
interface ConfirmationContentProps {
  details: ConfirmationDetails;
  headerColor: string;
  isPlanModeExit: boolean;
  isPlanModeEnter: boolean;
  terminalWidth: number;
}

const ConfirmationContent = React.memo<ConfirmationContentProps>(
  ({ details, headerColor, isPlanModeExit, isPlanModeEnter, terminalWidth }) => (
    <>
      <Box marginBottom={1}>
        <Text>{details.message}</Text>
      </Box>

      {/* 方案审核：保留 bordered box */}
      {details.planContent && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="single"
          borderColor={headerColor}
          padding={1}
        >
          <Text bold color={headerColor}>
            实施方案
          </Text>
          <Box marginTop={1}>
            <MessageRenderer
              content={details.planContent}
              role="assistant"
              terminalWidth={terminalWidth - 4}
            />
          </Box>
        </Box>
      )}

      {/* 普通操作详情：无边框，轻量渲染 */}
      {!details.planContent && details.details && (
        <Box flexDirection="column" marginBottom={1}>
          <MessageRenderer
            content={details.details}
            role="assistant"
            terminalWidth={terminalWidth}
          />
        </Box>
      )}

      {details.risks && details.risks.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            风险提示:
          </Text>
          {details.risks.map((risk, index) => (
            <Box key={index} marginLeft={2}>
              <Text color="red">• {risk}</Text>
            </Box>
          ))}
        </Box>
      )}

      {details.affectedFiles && details.affectedFiles.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">影响的文件:</Text>
          {details.affectedFiles.slice(0, 3).map((file, index) => (
            <Box key={index} marginLeft={2}>
              <Text>• {file}</Text>
            </Box>
          ))}
          {details.affectedFiles.length > 3 && (
            <Box marginLeft={2}>
              <Text color="gray">
                ...还有 {details.affectedFiles.length - 3} 个文件
              </Text>
            </Box>
          )}
        </Box>
      )}
    </>
  )
);

function getShortcutHint(
  isPlanModeExit: boolean,
  isPlanModeEnter: boolean,
  isMaxTurnsExceeded: boolean
): string {
  const shortcutText =
    isPlanModeEnter || isMaxTurnsExceeded
      ? 'Y/N'
      : isPlanModeExit
        ? 'Y/S/N'
        : 'Y/S/P/N';
  return `使用 ↑↓ 选择，回车确认 · ${shortcutText} 快捷键 · Esc 取消`;
}

/**
 * ConfirmationPrompt Props
 */
interface ConfirmationPromptProps {
  details: ConfirmationDetails;
  onResponse: (response: ConfirmationResponse) => void;
}

/**
 * ConfirmationPrompt 组件
 * 显示需要用户确认的工具调用详情,并等待用户响应
 */
export const ConfirmationPrompt: React.FC<ConfirmationPromptProps> = React.memo(
  ({ details, onResponse }) => {
    // 直接从 stdout 获取宽度，避免 useTerminalWidth 的 resize 监听导致不必要重渲染
    const { stdout } = useStdout();
    const terminalWidth = stdout.columns || 80;

    // 使用 Zustand store 管理焦点
    const currentFocus = useCurrentFocus();
    const isFocused = currentFocus === FocusId.CONFIRMATION_PROMPT;

    // 使用智能 Ctrl+C 处理（没有任务，所以直接退出）
    const handleCtrlC = useCtrlCHandler(false);

    // 确认类型判断（memo 化）
    const isPlanModeExit = details.type === 'exitPlanMode';
    const isPlanModeEnter = details.type === 'enterPlanMode';
    const isMaxTurnsExceeded = details.type === 'maxTurnsExceeded';

    // 处理键盘输入
    useInput(
      (input, key) => {
        // Ctrl+C 或 Cmd+C: 智能退出应用
        if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
          handleCtrlC();
          return;
        }

        // Esc: 取消确认
        if (key.escape) {
          onResponse({ approved: false, reason: '用户取消' });
          return;
        }

        // 快捷键处理
        const lowerInput = input.toLowerCase();

        if (isPlanModeExit) {
          // ExitPlanMode: Y/S/N (选择执行模式)
          if (lowerInput === 'y') {
            onResponse({ approved: true, targetMode: PermissionMode.AUTO_EDIT });
            return;
          }
          if (lowerInput === 's') {
            onResponse({ approved: true, targetMode: PermissionMode.DEFAULT });
            return;
          }
          if (lowerInput === 'n') {
            onResponse({ approved: false, reason: '方案需要改进' });
            return;
          }
        } else if (isPlanModeEnter) {
          // EnterPlanMode: Y/N (简单确认)
          if (lowerInput === 'y') {
            onResponse({ approved: true });
            return;
          }
          if (lowerInput === 'n') {
            onResponse({ approved: false, reason: '用户拒绝进入 Plan 模式' });
            return;
          }
        } else if (isMaxTurnsExceeded) {
          // MaxTurnsExceeded: Y/N (继续或停止)
          if (lowerInput === 'y') {
            onResponse({ approved: true });
            return;
          }
          if (lowerInput === 'n') {
            onResponse({ approved: false, reason: '用户选择停止' });
            return;
          }
        } else {
          // 普通确认: Y/S/N
          if (lowerInput === 'y') {
            onResponse({ approved: true, scope: 'once' });
            return;
          }
          if (lowerInput === 's') {
            onResponse({ approved: true, scope: 'session' });
            return;
          }
          if (lowerInput === 'p') {
            onResponse({ approved: true, scope: 'project' });
            return;
          }
          if (lowerInput === 'n') {
            onResponse({ approved: false, reason: '用户拒绝' });
            return;
          }
        }
      },
      { isActive: isFocused }
    );

    const options = useMemo<
      Array<{ label: string; key: string; value: ConfirmationResponse }>
    >(() => {
      if (isPlanModeExit) {
        return [
          {
            key: 'approve-auto',
            label: '[Y] 批准，自动执行',
            value: { approved: true, targetMode: PermissionMode.AUTO_EDIT },
          },
          {
            key: 'approve-default',
            label: '[S] 批准，逐步确认',
            value: { approved: true, targetMode: PermissionMode.DEFAULT },
          },
          {
            key: 'reject',
            label: '[N] 继续优化方案',
            value: { approved: false, reason: '方案需要改进' },
          },
        ];
      }

      if (isPlanModeEnter) {
        return [
          {
            key: 'approve',
            label: '[Y] 进入规划模式',
            value: { approved: true },
          },
          {
            key: 'reject',
            label: '[N] 直接执行',
            value: { approved: false, reason: '用户拒绝进入 Plan 模式' },
          },
        ];
      }

      if (isMaxTurnsExceeded) {
        return [
          {
            key: 'continue',
            label: '[Y] 继续执行',
            value: { approved: true },
          },
          {
            key: 'stop',
            label: '[N] 停止',
            value: { approved: false, reason: '用户选择停止' },
          },
        ];
      }

      return [
        {
          key: 'approve-once',
          label: '[Y] 允许（仅本次）',
          value: { approved: true, scope: 'once' },
        },
        {
          key: 'approve-session',
          label: '[S] 允许（本次会话）',
          value: { approved: true, scope: 'session' },
        },
        {
          key: 'approve-project',
          label: '[P] 允许并记住（本项目）',
          value: { approved: true, scope: 'project' },
        },
        {
          key: 'reject',
          label: '[N] 拒绝',
          value: { approved: false, reason: '用户拒绝' },
        },
      ];
    }, [isPlanModeExit, isPlanModeEnter, isMaxTurnsExceeded]);

    // Header 样式（memo 化）
    const headerStyle = useMemo(() => {
      if (isPlanModeExit) {
        return { color: 'cyan' as const, title: '方案审核' };
      }
      if (isPlanModeEnter) {
        return { color: 'magenta' as const, title: '进入规划模式' };
      }
      if (isMaxTurnsExceeded) {
        return { color: 'yellow' as const, title: '已达最大轮次' };
      }
      return { color: 'yellow' as const, title: details.title || '操作确认' };
    }, [isPlanModeExit, isPlanModeEnter, isMaxTurnsExceeded, details.title]);

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isFocused ? headerStyle.color : 'gray'}
        padding={1}
      >
        <Box marginBottom={1}>
          <Text bold color={headerStyle.color}>
            {headerStyle.title}
          </Text>
        </Box>

        {/* 静态内容区域 - 独立 memo 组件，不随 SelectInput 更新 */}
        <ConfirmationContent
          details={details}
          headerColor={headerStyle.color}
          isPlanModeExit={isPlanModeExit}
          isPlanModeEnter={isPlanModeEnter}
          terminalWidth={terminalWidth}
        />

        <Box flexDirection="column">
          <Text color="gray">
            {getShortcutHint(isPlanModeExit, isPlanModeEnter, isMaxTurnsExceeded)}
          </Text>
          <SelectInput
            items={options}
            isFocused={isFocused}
            itemComponent={ConfirmationItem}
            onSelect={(item) => {
              onResponse(item.value);
            }}
          />
        </Box>
      </Box>
    );
  }
);
