/**
 * 会话选择器组件
 * 用于交互式选择历史会话
 */

import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';
import { useTerminalInput as useInput } from '../input/TerminalInputRouter.js';
import {
  getSessionCandidateKey,
  getSessionSelectorCopy,
  getSessionSelectorLabel,
  getVisibleSessionCandidates,
} from './sessionSelectorModel.js';

interface SessionSelectorProps {
  intent: SessionSelectionIntent;
  sessions: SessionSurfaceSummary[];
  onSelect: (session: SessionSurfaceSummary) => void | Promise<void>;
  onCancel?: () => void; // 可选，用于 --resume CLI 模式，在 /resume 斜杠命令模式下由全局处理器处理
}

/**
 * 格式化时间戳为可读格式
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  if (diffDays === 1) {
    return '昨天';
  }
  if (diffDays < 7) {
    return `${diffDays}天前`;
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 自定义指示器组件 - 青色高亮
 */
const Indicator = ({ isSelected }: { isSelected?: boolean }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '>' : ' '}</Text>
  </Box>
);

/**
 * 自定义选项组件 - 选中时青色加粗
 */
const Item = ({ isSelected, label }: { isSelected?: boolean; label: string }) => (
  <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
    {label}
  </Text>
);

/**
 * 会话选择器组件
 */
// 每页显示的会话数量
const PAGE_SIZE = 20;

export const SessionSelector: React.FC<SessionSelectorProps> = ({
  intent,
  sessions: propSessions,
  onSelect,
  onCancel,
}) => {
  const [currentPage, setCurrentPage] = useState(0);
  const [isActivating, setIsActivating] = useState(false);
  const isActivatingRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 使用 Zustand store 管理焦点
  const currentFocus = useCurrentFocus();
  const isFocused = currentFocus === FocusId.SESSION_SELECTOR;

  // 使用智能 Ctrl+C 处理（没有任务，所以直接退出）
  const handleCtrlC = useCtrlCHandler(false);

  // 处理键盘输入
  useInput(
    (input, key) => {
      // Ctrl+C 或 Cmd+C: 智能退出应用
      if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
        return;
      }

      if (isActivatingRef.current) {
        return;
      }

      // Esc: 调用 onCancel 关闭选择器
      if (key.escape && onCancel) {
        onCancel();
        return;
      }

      // 翻页：左箭头或 h 键 - 上一页
      if (key.leftArrow || input === 'h' || input === 'H') {
        if (currentPage > 0) {
          setCurrentPage((prev) => prev - 1);
        }
        return;
      }

      // 翻页：右箭头或 l 键 - 下一页
      if (key.rightArrow || input === 'l' || input === 'L') {
        if (currentPage < totalPages - 1) {
          setCurrentPage((prev) => prev + 1);
        }
        return;
      }
    },
    { isActive: isFocused } // 只在有焦点时激活
  );

  const sessions = useMemo(
    () => getVisibleSessionCandidates(propSessions, intent),
    [intent, propSessions]
  );
  const copy = useMemo(() => getSessionSelectorCopy(intent), [intent]);

  // 转换为 SelectInput 的 items 格式
  const items = useMemo(() => {
    return sessions.map((session) => {
      const timeStr = formatTimestamp(session.lastMessageTime);

      return {
        key: getSessionCandidateKey(session),
        label: getSessionSelectorLabel(session, timeStr),
        value: session,
      };
    });
  }, [sessions]);

  // 分页计算
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    [items.length]
  );

  const paginatedItems = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, currentPage]);

  const displayRange = useMemo(
    () => ({
      start: currentPage * PAGE_SIZE + 1,
      end: Math.min((currentPage + 1) * PAGE_SIZE, items.length),
    }),
    [currentPage, items.length]
  );

  // 会话变化时重置页码
  useEffect(() => {
    setCurrentPage(0);
  }, [sessions.length]);

  const handleSelect = (item: { label: string; value: SessionSurfaceSummary }) => {
    if (isActivatingRef.current) {
      return;
    }

    isActivatingRef.current = true;
    setIsActivating(true);
    const settle = () => {
      if (!isMountedRef.current) {
        return;
      }
      isActivatingRef.current = false;
      setIsActivating(false);
    };

    void Promise.resolve()
      .then(() => onSelect(item.value))
      .then(settle, settle);
  };

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">没有找到历史会话</Text>
        <Text dimColor>
          {'\n'}提示: 开始一次对话后，会话历史将保存到 ~/.blade/projects/
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        {copy.title}
      </Text>
      <Text dimColor>
        {'\n'}
        {copy.instructions}
        {'\n'}
      </Text>

      <SelectInput
        items={paginatedItems}
        onSelect={handleSelect}
        isFocused={isFocused && !isActivating}
        indicatorComponent={Indicator}
        itemComponent={Item}
      />

      {isActivating && (
        <Text color="cyan">{intent === 'fork' ? 'Forking…' : 'Resuming…'}</Text>
      )}

      {/* 分页状态栏 */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          第 {currentPage + 1}/{totalPages} 页 · 共 {sessions.length} 个会话 · 显示{' '}
          {displayRange.start}-{displayRange.end}
        </Text>

        {/* 翻页导航提示（仅在有多页时显示） */}
        {totalPages > 1 && (
          <Box marginTop={1}>
            <Text color={currentPage > 0 ? 'cyan' : 'gray'}>
              {currentPage > 0 ? '<< 上一页' : '        '}
            </Text>
            <Text> </Text>
            <Text color={currentPage < totalPages - 1 ? 'cyan' : 'gray'}>
              {currentPage < totalPages - 1 ? '下一页 >>' : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
