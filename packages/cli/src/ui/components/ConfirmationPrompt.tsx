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
      {details.title && (
        <Box marginBottom={1}>
          <Text bold>{details.title}</Text>
        </Box>
      )}

      <Box marginBottom={1}>
        <Text>{details.message}</Text>
      </Box>

      {(details.planContent || details.details) && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="single"
          borderColor={headerColor}
          padding={1}
        >
          <Text bold color={headerColor}>
            {isPlanModeExit
              ? 'Implementation Plan:'
              : isPlanModeEnter
                ? 'Details:'
                : 'Operation Details:'}
          </Text>
          <Box marginTop={1}>
            <MessageRenderer
              content={details.planContent || details.details || ''}
              role="assistant"
              terminalWidth={terminalWidth - 4}
            />
          </Box>
        </Box>
      )}

      {details.risks && details.risks.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            [WARN] 风险提示:
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
            label: '[Y] Yes, execute with auto-edit mode',
            value: { approved: true, targetMode: PermissionMode.AUTO_EDIT },
          },
          {
            key: 'approve-default',
            label: '[S] Yes, execute with default mode (ask for each operation)',
            value: { approved: true, targetMode: PermissionMode.DEFAULT },
          },
          {
            key: 'reject',
            label: '[N] No, keep planning',
            value: { approved: false, reason: '方案需要改进' },
          },
        ];
      }

      if (isPlanModeEnter) {
        return [
          {
            key: 'approve',
            label: '[Y] Yes, enter Plan mode',
            value: { approved: true },
          },
          {
            key: 'reject',
            label: '[N] No, proceed directly',
            value: { approved: false, reason: '用户拒绝进入 Plan 模式' },
          },
        ];
      }

      if (isMaxTurnsExceeded) {
        return [
          {
            key: 'continue',
            label: '[Y] Yes, continue',
            value: { approved: true },
          },
          {
            key: 'stop',
            label: '[N] No, stop here',
            value: { approved: false, reason: '用户选择停止' },
          },
        ];
      }

      return [
        {
          key: 'approve-once',
          label: '[Y] Yes (once only)',
          value: { approved: true, scope: 'once' },
        },
        {
          key: 'approve-session',
          label: '[S] Yes, remember for this project (Shift+Tab)',
          value: { approved: true, scope: 'session' },
        },
        {
          key: 'reject',
          label: '[N] No',
          value: { approved: false, reason: '用户拒绝' },
        },
      ];
    }, [isPlanModeExit, isPlanModeEnter, isMaxTurnsExceeded]);

    // Header 样式（memo 化）
    const headerStyle = useMemo(() => {
      if (isPlanModeExit) {
        return {
          color: 'cyan' as const,
          title: 'Plan Mode - Review Implementation Plan',
        };
      }
      if (isPlanModeEnter) {
        return { color: 'magenta' as const, title: 'Enter Plan Mode?' };
      }
      if (isMaxTurnsExceeded) {
        return { color: 'yellow' as const, title: 'Max Turns Exceeded' };
      }
      return { color: 'yellow' as const, title: 'Confirmation Required' };
    }, [isPlanModeExit, isPlanModeEnter, isMaxTurnsExceeded]);

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
            使用 Up/Down 选择，回车确认（支持 Y/S/N 快捷键，ESC 取消）
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
