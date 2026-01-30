/**
 * 交互式版本更新提示组件
 *
 */

import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { getGracefulShutdown } from '../../services/GracefulShutdown.js';
import {
  getUpgradeCommand,
  performUpgrade,
  setSkipUntilVersion,
  type VersionCheckResult,
} from '../../services/VersionChecker.js';

interface UpdatePromptProps {
  versionInfo: VersionCheckResult;
  onComplete: () => void;
}

type UpdateChoice = 'update' | 'skip' | 'skip_until_next';

interface ChoiceItem {
  key: UpdateChoice;
  label: string;
  description: string;
}

const choices: ChoiceItem[] = [
  {
    key: 'update',
    label: 'Update now',
    description: `runs \`${getUpgradeCommand()}\``,
  },
  {
    key: 'skip',
    label: 'Skip',
    description: '',
  },
  {
    key: 'skip_until_next',
    label: 'Skip until next version',
    description: '',
  },
];

export const UpdatePrompt: React.FC<UpdatePromptProps> = ({
  versionInfo,
  onComplete,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);

  useInput((input, key) => {
    // Ctrl+C 直接退出程序
    if (key.ctrl && input === 'c') {
      getGracefulShutdown().shutdown('SIGINT', 0);
      return;
    }

    if (isUpdating || updateResult) return;

    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : choices.length - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => (prev < choices.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      handleSelect(choices[selectedIndex].key);
    } else if (input === '1') {
      handleSelect('update');
    } else if (input === '2') {
      handleSelect('skip');
    } else if (input === '3') {
      handleSelect('skip_until_next');
    }
  });

  const handleSelect = async (choice: UpdateChoice) => {
    switch (choice) {
      case 'update': {
        setIsUpdating(true);
        const result = await performUpgrade();
        setUpdateResult(result.message);
        // 更新完成后直接退出
        setTimeout(() => {
          getGracefulShutdown().shutdown('SIGINT', 0);
        }, 1500);
        break;
      }

      case 'skip':
        onComplete();
        break;

      case 'skip_until_next':
        if (versionInfo.latestVersion) {
          await setSkipUntilVersion(versionInfo.latestVersion);
        }
        onComplete();
        break;
    }
  };

  // 显示更新结果
  if (updateResult) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text>{updateResult}</Text>
      </Box>
    );
  }

  // 显示更新中
  if (isUpdating) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="cyan">Updating...</Text>
      </Box>
    );
  }

  // 使用固定颜色，适配暗色和亮色终端
  return (
    <Box flexDirection="column" marginY={1}>
      {/* 标题 */}
      <Text color="yellow" bold>
        {'✨ Update available! '}
        <Text color="gray">
          {versionInfo.currentVersion} {'→'} {versionInfo.latestVersion}
        </Text>
      </Text>

      {/* Release notes 链接 */}
      <Box marginTop={1}>
        <Text color="gray">
          Release notes:{' '}
          <Text color="cyan" underline>
            {versionInfo.releaseNotesUrl}
          </Text>
        </Text>
      </Box>

      {/* 选项列表 */}
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, index) => {
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? '› ' : '  ';
          const number = `${index + 1}. `;

          return (
            <Box key={choice.key}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {prefix}
                {number}
                {choice.label}
                {choice.description && (
                  <Text color="gray"> ({choice.description})</Text>
                )}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* 操作提示 */}
      <Box marginTop={1}>
        <Text color="gray">Press enter to continue</Text>
      </Box>
    </Box>
  );
};
