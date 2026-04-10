/**
 * Spec 状态面板组件
 *
 * 显示当前 Spec 的状态、阶段进度和任务列表
 */

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { SpecManager } from '../../spec/SpecManager.js';
import {
  PHASE_DISPLAY_NAMES,
  type SpecMetadata,
  type SpecPhase,
  type SpecTask,
} from '../../spec/types.js';

/**
 * 阶段进度图标
 */
const PHASE_ICONS: Record<SpecPhase, string> = {
  init: '',
  requirements: '',
  design: '',
  tasks: '',
  implementation: '',
  done: '',
};

/**
 * 阶段顺序
 */
const PHASE_ORDER: SpecPhase[] = [
  'init',
  'requirements',
  'design',
  'tasks',
  'implementation',
  'done',
];

/**
 * 任务状态图标
 */
const TASK_STATUS_ICONS: Record<string, string> = {
  pending: '-',
  in_progress: '~',
  completed: '*',
  blocked: 'x',
};

/**
 * 任务状态颜色
 */
const TASK_STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
  blocked: 'red',
};

interface SpecStatusPanelProps {
  /** 是否展开显示任务列表 */
  expanded?: boolean;
  /** 最大显示任务数 */
  maxTasks?: number;
}

/**
 * Spec 状态面板
 */
export const SpecStatusPanel: React.FC<SpecStatusPanelProps> = React.memo(
  ({ expanded = false, maxTasks = 5 }) => {
    const [spec, setSpec] = useState<SpecMetadata | null>(null);

    useEffect(() => {
      const specManager = SpecManager.getInstance();
      setSpec(specManager.getCurrentSpec());

      // 定期刷新（每秒检查一次）
      const interval = setInterval(() => {
        setSpec(specManager.getCurrentSpec());
      }, 1000);

      return () => clearInterval(interval);
    }, []);

    if (!spec) {
      return null;
    }

    const currentPhaseIndex = PHASE_ORDER.indexOf(spec.phase);
    const progress =
      spec.tasks.length > 0
        ? Math.round(
            (spec.tasks.filter((t) => t.status === 'completed').length /
              spec.tasks.length) *
              100
          )
        : 0;

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="blue"
        paddingX={1}
        marginBottom={1}
      >
        {/* 标题行 */}
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="blue" bold>
            Spec: {spec.name}
          </Text>
          <Text color="gray">
            {PHASE_ICONS[spec.phase]} {PHASE_DISPLAY_NAMES[spec.phase]}
          </Text>
        </Box>

        {/* 阶段进度条 */}
        <Box flexDirection="row" marginTop={1}>
          {PHASE_ORDER.map((phase, index) => {
            const isCompleted = index < currentPhaseIndex;
            const isCurrent = index === currentPhaseIndex;
            const icon = isCompleted ? '*' : isCurrent ? '>' : '-';
            const color = isCompleted ? 'green' : isCurrent ? 'blue' : 'gray';

            return (
              <Box key={phase} flexDirection="row">
                <Text color={color}>{icon}</Text>
                {index < PHASE_ORDER.length - 1 && (
                  <Text color={isCompleted ? 'green' : 'gray'}>──</Text>
                )}
              </Box>
            );
          })}
          <Text color="gray"> ({progress}%)</Text>
        </Box>

        {/* 阶段标签 */}
        <Box flexDirection="row" marginTop={0}>
          <Text color="gray" dimColor>
            {PHASE_ORDER.map((phase, index) => {
              const shortName = phase.slice(0, 3).toUpperCase();
              const isCurrent = index === currentPhaseIndex;
              return isCurrent ? `[${shortName}]` : ` ${shortName} `;
            }).join('')}
          </Text>
        </Box>

        {/* 任务列表（展开模式） */}
        {expanded && spec.tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray" dimColor>
              ─── Tasks ({spec.tasks.filter((t) => t.status === 'completed').length}/
              {spec.tasks.length}) ───
            </Text>
            {spec.tasks.slice(0, maxTasks).map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                isCurrent={task.id === spec.currentTaskId}
              />
            ))}
            {spec.tasks.length > maxTasks && (
              <Text color="gray" dimColor>
                ... and {spec.tasks.length - maxTasks} more tasks
              </Text>
            )}
          </Box>
        )}

        {/* 简洁模式：仅显示当前任务 */}
        {!expanded && spec.currentTaskId && (
          <Box flexDirection="row" marginTop={1}>
            <Text color="gray">Current: </Text>
            <Text color="yellow">
              {spec.tasks.find((t) => t.id === spec.currentTaskId)?.title || 'Unknown'}
            </Text>
          </Box>
        )}
      </Box>
    );
  }
);

/**
 * 任务项组件
 */
const TaskItem: React.FC<{ task: SpecTask; isCurrent: boolean }> = React.memo(
  ({ task, isCurrent }) => {
    const icon = TASK_STATUS_ICONS[task.status] || '?';
    const color = TASK_STATUS_COLORS[task.status] || 'gray';

    return (
      <Box flexDirection="row">
        <Text color={color}>{icon} </Text>
        <Text color={isCurrent ? 'yellow' : 'white'} bold={isCurrent}>
          {task.title}
        </Text>
        {task.complexity && (
          <Text color="gray" dimColor>
            {' '}
            [{task.complexity}]
          </Text>
        )}
      </Box>
    );
  }
);
