/**
 * UI组件测试和示例
 * 展示重构后的主题化组件使用方法
 */

import React from 'react';
import { Box } from './Box.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { ThemeProvider } from './ThemeAdapter.js';

/**
 * 主题化UI示例组件
 */
export const ThemedUIExample: React.FC = () => {
  return (
    <ThemeProvider>
      <Box variant="container">
        <Text variant="primary" bold>
          Blade UI 主题系统示例
        </Text>

        <Box variant="section">
          <Text variant="secondary">这是一个展示主题化组件的示例界面</Text>
        </Box>

        <Box flexDirection="column" gap={1}>
          <Button variant="primary" size="md">
            主要按钮
          </Button>

          <Button variant="secondary" size="md">
            次要按钮
          </Button>

          <Button variant="success" size="md">
            成功按钮
          </Button>

          <Button variant="warning" size="md">
            警告按钮
          </Button>

          <Button variant="error" size="md">
            错误按钮
          </Button>

          <Button variant="ghost" size="md">
            幽灵按钮
          </Button>
        </Box>

        <Box variant="card" marginTop={1}>
          <Text variant="info" bold>
            卡片标题
          </Text>
          <Text variant="secondary">这是一个使用卡片样式的容器组件</Text>
        </Box>
      </Box>
    </ThemeProvider>
  );
};

/**
 * 不同主题示例
 */
export const ThemeVariantsExample: React.FC = () => {
  return (
    <Box flexDirection="column" gap={2}>
      <Text bold>不同主题变体示例</Text>

      <Box>
        <Text color="#3B82F6">自定义蓝色文本</Text>
      </Box>

      <Box>
        <Button backgroundColor="#8B5CF6" borderColor="#8B5CF6" color="white">
          紫色按钮
        </Button>
      </Box>

      <Box
        backgroundColor="#FEF3C7"
        padding={1}
        borderStyle="round"
        borderColor="#F59E0B"
      >
        <Text color="#92400E">自定义警告消息框</Text>
      </Box>
    </Box>
  );
};

/**
 * 响应式布局示例
 */
export const LayoutExample: React.FC = () => {
  return (
    <Box flexDirection="column" gap={1}>
      <Text variant="primary" bold>
        响应式布局示例
      </Text>

      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        padding={1}
        borderStyle="round"
        borderColor="#D1D5DB"
      >
        <Text variant="secondary">左侧内容</Text>
        <Text variant="secondary">右侧内容</Text>
      </Box>

      <Box flexDirection="column" gap={1} padding={1} backgroundColor="#F9FAFB">
        <Text variant="info">列表项 1</Text>
        <Text variant="info">列表项 2</Text>
        <Text variant="info">列表项 3</Text>
      </Box>
    </Box>
  );
};

export default {
  ThemedUIExample,
  ThemeVariantsExample,
  LayoutExample,
};
