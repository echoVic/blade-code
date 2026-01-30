import { Box, Text } from 'ink';
import React from 'react';
import { PermissionMode } from '../../config/types.js';
import {
  useActiveModal,
  useAwaitingSecondCtrlC,
  useContextRemaining,
  useCurrentModel,
  useIsCompacting,
  useIsReady,
  usePermissionMode,
  useSpecProgress,
  useThinkingModeEnabled,
} from '../../store/selectors/index.js';
import { isThinkingModel } from '../../utils/modelDetection.js';
import { useGitBranch } from '../hooks/useGitBranch.js';

/**
 * 聊天状态栏组件
 * 显示权限模式、快捷键提示、API状态和处理状态
 *
 * 状态管理：
 * - 使用 Zustand selectors 获取状态（SSOT）
 * - Spec 进度从 Store 读取（SpecManager 更新 Store）
 */
export const ChatStatusBar: React.FC = React.memo(() => {
  // 使用 Zustand selectors 获取状态
  const hasApiKey = useIsReady();
  const permissionMode = usePermissionMode();
  const activeModal = useActiveModal();
  const showShortcuts = activeModal === 'shortcuts';
  const awaitingSecondCtrlC = useAwaitingSecondCtrlC();
  const { branch } = useGitBranch();
  const currentModel = useCurrentModel();
  const contextRemaining = useContextRemaining();
  const isCompacting = useIsCompacting();
  const thinkingModeEnabled = useThinkingModeEnabled();

  // 从 Store 读取 Spec 进度（SSOT）
  const specProgress = useSpecProgress();

  // 检查当前模型是否支持 thinking
  const supportsThinking = currentModel ? isThinkingModel(currentModel) : false;
  // 渲染模式提示（仅非 DEFAULT 模式显示）
  const renderModeIndicator = () => {
    if (permissionMode === PermissionMode.DEFAULT) {
      return null; // DEFAULT 模式不显示任何提示
    }

    if (permissionMode === PermissionMode.AUTO_EDIT) {
      return (
        <Text color="magenta">
          ▶▶ auto edit on <Text color="gray">(shift+tab to cycle)</Text>
        </Text>
      );
    }

    if (permissionMode === PermissionMode.PLAN) {
      return (
        <Text color="cyan">
          ‖ plan mode on <Text color="gray">(shift+tab to cycle)</Text>
        </Text>
      );
    }

    if (permissionMode === PermissionMode.YOLO) {
      return (
        <Text color="red">
          ⚡ yolo mode on <Text color="gray">(all tools auto-approved)</Text>
        </Text>
      );
    }

    if (permissionMode === PermissionMode.SPEC) {
      // 增强的 Spec 模式显示：阶段 + 进度
      const { phase, completed, total } = specProgress;
      let phaseDisplay: string;

      if (!phase) {
        phaseDisplay = 'init';
      } else if ((phase === 'tasks' || phase === 'implementation') && total > 0) {
        phaseDisplay = `${phase} ${completed}/${total}`;
      } else {
        phaseDisplay = phase;
      }

      return (
        <Text color="blue">
          📋 spec: {phaseDisplay} <Text color="gray">(shift+tab to cycle)</Text>
        </Text>
      );
    }

    return null;
  };

  const modeIndicator = renderModeIndicator();
  const hasModeIndicator = modeIndicator !== null;

  // 快捷键列表 - 紧凑三列布局
  const shortcutRows = [
    ['Enter:发送', 'Shift+Enter:换行', 'Esc:中止'],
    ['Shift+Tab:切换模式', '↑/↓:历史', 'Tab:补全'],
    ['Ctrl+A:行首', 'Ctrl+E:行尾', 'Ctrl+K:删到尾'],
    ['Ctrl+U:删到首', 'Ctrl+W:删单词', 'Ctrl+C:退出'],
  ];

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={0}>
      {showShortcuts ? (
        <Box flexDirection="column" gap={0}>
          {shortcutRows.map((row, rowIndex) => (
            <Box key={rowIndex} flexDirection="row">
              {row.map((shortcut, index) => {
                const [key, desc] = shortcut.split(':');
                return (
                  <Box key={index} flexDirection="row" width={20}>
                    <Text color="yellow">{key}</Text>
                    <Text color="gray">:</Text>
                    <Text color="white">{desc}</Text>
                  </Box>
                );
              })}
              {rowIndex === shortcutRows.length - 1 && (
                <Text color="cyan"> ? 关闭</Text>
              )}
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          {branch && (
            <>
              <Text color="gray"> {branch}</Text>
              <Text color="gray">·</Text>
            </>
          )}
          {modeIndicator}
          {hasModeIndicator && <Text color="gray">·</Text>}
          <Text color="gray">? for shortcuts</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        {!hasApiKey ? (
          <Text color="red">⚠ API 密钥未配置</Text>
        ) : (
          <>
            {/* Thinking 模式指示器（仅当模型支持时显示） */}
            {supportsThinking && (
              <>
                {thinkingModeEnabled ? (
                  <Text color="cyan">Thinking on</Text>
                ) : (
                  <Text color="gray">Tab:Thinking</Text>
                )}
                <Text color="gray">·</Text>
              </>
            )}
            {currentModel && <Text color="gray">{currentModel.model}</Text>}
            <Text color="gray">·</Text>
            {isCompacting ? (
              <Text color="yellow">压缩中...</Text>
            ) : (
              <Text
                color={
                  contextRemaining < 20
                    ? 'red'
                    : contextRemaining < 50
                      ? 'yellow'
                      : 'gray'
                }
              >
                {contextRemaining}%
              </Text>
            )}

            {awaitingSecondCtrlC && (
              <>
                <Text color="gray">·</Text>
                <Text color="yellow">再按一次 Ctrl+C 退出</Text>
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
});
