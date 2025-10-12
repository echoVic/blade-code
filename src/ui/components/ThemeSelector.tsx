/**
 * ThemeSelector - 交互式主题选择器组件
 * 类似 Claude Code 的交互式可视化选择器
 */
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useState } from 'react';
import { ConfigManager } from '../../config/config-manager.js';
import { useAppState } from '../contexts/AppContext.js';
import { themes } from '../themes/index.js';
import { themeManager } from '../themes/theme-manager.js';
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
  const { dispatch, actions } = useAppState();
  const [selectedTheme, setSelectedTheme] = useState<Theme>(themeManager.getTheme());
  const [isProcessing, setIsProcessing] = useState(false);
  const currentThemeName = themeManager.getCurrentThemeName();

  // 处理主题选择
  const handleSelect = async (item: { label: string; value: string }) => {
    if (isProcessing) return;

    setIsProcessing(true);

    try {
      // 切换主题
      themeManager.setTheme(item.value);

      // 保存到配置
      const configManager = new ConfigManager();
      await configManager.initialize();
      const currentConfig = configManager.getConfig();

      await configManager.updateConfig({
        ui: {
          ...currentConfig.ui,
          theme: item.value,
        },
      });

      // 显示成功通知
      dispatch(
        actions.addNotification({
          type: 'success',
          title: '主题已更新',
          message: `已切换到 ${item.label} 主题`,
          duration: 3000,
        })
      );

      // 关闭选择器
      dispatch(actions.hideThemeSelector());
    } catch (error) {
      // 显示错误通知
      dispatch(
        actions.addNotification({
          type: 'error',
          title: '主题切换失败',
          message: error instanceof Error ? error.message : '未知错误',
          duration: 5000,
        })
      );
    } finally {
      setIsProcessing(false);
    }
  };

  // 处理主题切换 (上下键预览)
  const handleHighlight = (item: { label: string; value: string }) => {
    const themeItem = themes.find((t) => t.id === item.value);
    if (themeItem) {
      setSelectedTheme(themeItem.theme);
    }
  };

  // 监听 Esc 键退出
  useInput((input, key) => {
    if (key.escape && !isProcessing) {
      dispatch(actions.hideThemeSelector());
    }
  });

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
