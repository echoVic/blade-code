import { Box, Text, useFocus, useInput } from 'ink';
import SelectInput, { type ItemProps as SelectItemProps } from 'ink-select-input';
import React, { useMemo } from 'react';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { ConfirmationDetails } from '../../tools/types/ToolTypes.js';

const ConfirmationItem = ({ label, isSelected }: SelectItemProps) => (
  <Text color={isSelected ? 'yellow' : undefined}>{label}</Text>
);

/**
 * ConfirmationPrompt Props
 */
export interface ConfirmationPromptProps {
  details: ConfirmationDetails;
  onResponse: (response: ConfirmationResponse) => void;
}

/**
 * ConfirmationPrompt 组件
 * 显示需要用户确认的工具调用详情,并等待用户响应
 */
export const ConfirmationPrompt: React.FC<ConfirmationPromptProps> = ({
  details,
  onResponse,
}) => {
  // 使用 useFocus 管理焦点，使用显式 ID（遵循焦点管理最佳实践）
  const { isFocused } = useFocus({ id: 'confirmation-prompt' });

  // 只处理 ESC 键取消，其他按键交给 SelectInput 处理
  useInput(
    (input, key) => {
      if (!isFocused) return;

      if (key.escape) {
        onResponse({ approved: false, reason: '用户取消' });
        return;
      }
    },
    { isActive: isFocused }
  );

  const options = useMemo<
    Array<{ label: string; key: string; value: ConfirmationResponse }>
  >(() => {
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
  }, []);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'yellow' : 'gray'}
      padding={1}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">
          🔔 需要用户确认
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold>{details.title}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{details.message}</Text>
      </Box>

      {details.risks && details.risks.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            ⚠️ 风险提示:
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
          <Text color="yellow">📁 影响的文件:</Text>
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

      <Box flexDirection="column">
        <Text color="gray">
          使用 ↑ ↓ 选择，回车确认（支持 Y / S / N 快捷键，ESC 取消）
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
};
