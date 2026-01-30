/**
 * ThemeSelector - 交互式主题选择器组件
 */

import { useMemoizedFn } from 'ahooks';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useState } from 'react';
import { useAppActions, useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { configActions } from '../../store/vanilla.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';
import { themes } from '../themes/index.js';
import { themeManager } from '../themes/ThemeManager.js';
import type { Theme } from '../themes/types.js';

// 准备 SelectInput 需要的数据格式
const themeSelectItems = themes.map((item) => ({
  label: item.label, // 显示友好的名称，如 "Tokyo Night"
  value: item.id, // 使用 id 作为值，如 "tokyo-night"
}));

/**
 * 代码预览组件
 */
const CodePreview: React.FC<{ theme: Theme }> = ({ theme }) => {
  const { colors } = theme;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold color={colors.text.primary}>
        代码预览
      </Text>
      <Text> </Text>

      {/* Python 函数示例 */}
      <Text color={colors.syntax.comment}># function</Text>
      <Text>
        <Text color={colors.syntax.keyword}>def</Text>{' '}
        <Text color={colors.syntax.function}>fibonacci</Text>
        <Text color={colors.text.primary}>(</Text>
        <Text color={colors.syntax.variable}>n</Text>
        <Text color={colors.text.primary}>):</Text>
      </Text>
      <Text>
        {'    '}
        <Text color={colors.syntax.variable}>a</Text>
        <Text color={colors.syntax.operator}>,</Text>{' '}
        <Text color={colors.syntax.variable}>b</Text>{' '}
        <Text color={colors.syntax.operator}>=</Text>{' '}
        <Text color={colors.syntax.number}>0</Text>
        <Text color={colors.syntax.operator}>,</Text>{' '}
        <Text color={colors.syntax.number}>1</Text>
      </Text>
      <Text>
        {'    '}
        <Text color={colors.syntax.keyword}>for</Text>{' '}
        <Text color={colors.syntax.variable}>_</Text>{' '}
        <Text color={colors.syntax.keyword}>in</Text>{' '}
        <Text color={colors.syntax.function}>range</Text>
        <Text color={colors.text.primary}>(</Text>
        <Text color={colors.syntax.variable}>n</Text>
        <Text color={colors.text.primary}>):</Text>
      </Text>
      <Text>
        {'        '}
        <Text color={colors.syntax.variable}>a</Text>
        <Text color={colors.syntax.operator}>,</Text>{' '}
        <Text color={colors.syntax.variable}>b</Text>{' '}
        <Text color={colors.syntax.operator}>=</Text>{' '}
        <Text color={colors.syntax.variable}>b</Text>
        <Text color={colors.syntax.operator}>,</Text>{' '}
        <Text color={colors.syntax.variable}>a</Text>{' '}
        <Text color={colors.syntax.operator}>+</Text>{' '}
        <Text color={colors.syntax.variable}>b</Text>
      </Text>
      <Text>
        {'    '}
        <Text color={colors.syntax.keyword}>return</Text>{' '}
        <Text color={colors.syntax.variable}>a</Text>
      </Text>

      <Text> </Text>

      {/* Git diff 示例 */}
      <Text color={colors.error}>
        - print(<Text color={colors.syntax.string}>"Hello, "</Text> + name)
      </Text>
      <Text color={colors.success}>
        + print(
        <Text color={colors.syntax.string}>
          f"Hello, {'{'}name{'}'}"
        </Text>
        )
      </Text>
    </Box>
  );
};

/**
 * 颜色信息组件
 */
const ColorInfo: React.FC<{ theme: Theme }> = ({ theme }) => {
  const { colors } = theme;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text> </Text>
      <Text bold color={colors.text.primary}>
        颜色配置
      </Text>
      <Text> </Text>
      <Text>
        <Text color={colors.text.muted}>Primary: </Text>
        <Text color={colors.primary}>{colors.primary}</Text>
      </Text>
      <Text>
        <Text color={colors.text.muted}>Success: </Text>
        <Text color={colors.success}>{colors.success}</Text>
      </Text>
      <Text>
        <Text color={colors.text.muted}>Error: </Text>
        <Text color={colors.error}>{colors.error}</Text>
      </Text>
      <Text>
        <Text color={colors.text.muted}>Warning: </Text>
        <Text color={colors.warning}>{colors.warning}</Text>
      </Text>
      <Text>
        <Text color={colors.text.muted}>Info: </Text>
        <Text color={colors.info}>{colors.info}</Text>
      </Text>
    </Box>
  );
};

/**
 * 主题选择器组件
 */
export const ThemeSelector: React.FC = () => {
  const appActions = useAppActions();
  const currentThemeName = themeManager.getCurrentThemeName();

  // 找到当前主题在列表中的索引，默认高亮当前主题
  const currentThemeIndex = themes.findIndex((t) => t.label === currentThemeName);
  const initialTheme =
    currentThemeIndex >= 0 ? themes[currentThemeIndex].theme : themes[0].theme;

  const [selectedTheme, setSelectedTheme] = useState<Theme>(initialTheme);
  const [isProcessing, setIsProcessing] = useState(false);

  // 处理主题选择
  const handleSelect = useMemoizedFn(async (item: { label: string; value: string }) => {
    if (isProcessing) return;

    setIsProcessing(true);

    try {
      // 使用 configActions 统一更新（同时更新 themeManager + Store + 持久化）
      await configActions().setTheme(item.value);

      // 关闭选择器
      appActions.closeModal();
    } catch (error) {
      // 输出错误到控制台
      console.error('❌ 主题切换失败:', error instanceof Error ? error.message : error);
    } finally {
      setIsProcessing(false);
    }
  });

  // 处理主题切换 (上下键预览)
  const handleHighlight = (item: { label: string; value: string }) => {
    const themeItem = themes.find((t) => t.id === item.value);
    if (themeItem) {
      setSelectedTheme(themeItem.theme);
    }
  };

  // 使用 Zustand store 管理焦点
  const currentFocus = useCurrentFocus();
  const isFocused = currentFocus === FocusId.THEME_SELECTOR;

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

      // Esc: 关闭主题选择器
      if (key.escape && !isProcessing) {
        appActions.closeModal();
      }
    },
    { isActive: isFocused }
  );

  // 自定义主题项渲染器
  const renderThemeItem = (props: { isSelected?: boolean; label: string }) => {
    const { isSelected, label } = props;
    const isCurrent = label === currentThemeName;
    const marker = isCurrent ? '✓' : ' ';

    return (
      <Text
        color={
          isSelected ? selectedTheme.colors.primary : selectedTheme.colors.text.primary
        }
      >
        {marker} {label}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* 标题栏 */}
      <Box
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={selectedTheme.colors.border.light}
      >
        <Text bold color={selectedTheme.colors.primary}>
          🎨 主题选择器
        </Text>
      </Box>

      {/* 主内容区 */}
      <Box flexDirection="row" flexGrow={1}>
        {/* 左侧: 主题列表 */}
        <Box
          width="40%"
          borderStyle="single"
          borderColor={selectedTheme.colors.border.light}
          paddingX={1}
        >
          <Box flexDirection="column">
            <Box paddingTop={1} paddingBottom={1}>
              <Text bold color={selectedTheme.colors.text.primary}>
                可用主题 ({themeSelectItems.length})
              </Text>
            </Box>
            <SelectInput
              items={themeSelectItems}
              initialIndex={currentThemeIndex >= 0 ? currentThemeIndex : 0}
              onSelect={handleSelect}
              onHighlight={handleHighlight}
              itemComponent={renderThemeItem}
            />
          </Box>
        </Box>

        {/* 右侧: 预览面板 */}
        <Box
          width="60%"
          flexDirection="column"
          borderStyle="single"
          borderColor={selectedTheme.colors.border.light}
        >
          <CodePreview theme={selectedTheme} />
          <ColorInfo theme={selectedTheme} />
        </Box>
      </Box>

      {/* 底部提示栏 */}
      <Box
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={selectedTheme.colors.border.light}
      >
        <Text color={selectedTheme.colors.text.muted}>
          {isProcessing ? '正在保存...' : 'Enter: 选择主题 | Esc: 取消'}
        </Text>
      </Box>
    </Box>
  );
};
