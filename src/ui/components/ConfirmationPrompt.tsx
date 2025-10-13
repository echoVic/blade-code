import { Box, Text, useInput } from 'ink';
import React from 'react';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { ConfirmationDetails } from '../../tools/types/ToolTypes.js';

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
  // 使用 Ink 的 useInput hook 处理键盘输入
  useInput((input, key) => {
    // 按 Y 或 y 批准
    if (input === 'y' || input === 'Y') {
      onResponse({ approved: true });
    }
    // 按 N 或 n 拒绝
    else if (input === 'n' || input === 'N') {
      onResponse({ approved: false, reason: '用户拒绝' });
    }
    // 按 ESC 取消(等同于拒绝)
    else if (key.escape) {
      onResponse({ approved: false, reason: '用户取消' });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
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

      <Box>
        <Text>
          <Text color="green" bold>
            [Y]
          </Text>
          <Text> 批准 / </Text>
          <Text color="red" bold>
            [N]
          </Text>
          <Text> 拒绝</Text>
        </Text>
      </Box>
    </Box>
  );
};
