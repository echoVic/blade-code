import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import React from 'react';
import { getCopyright } from '../../utils/packageInfo.js';

/**
 * 应用头部组件
 * 显示 ASCII Logo、使用指南
 *
 */
export const Header: React.FC = React.memo(() => {
  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={1}>
      {/* Logo 使用 BigText + Gradient 渲染渐变效果 */}
      <Box flexDirection="column">
        <Gradient name="pastel">
          <BigText text="BLADE" font="block" />
        </Gradient>
      </Box>

      {/* 版权信息 - 小字灰色，紧跟在 Logo 下面 */}
      <Box marginBottom={1}>
        <Text color="white" dimColor>
          {getCopyright()}
        </Text>
      </Box>

      {/* 使用指南 */}
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text color="white" bold>
            使用指南：
          </Text>
        </Box>
        <Text color="white">1. 输入问题、编辑文件或运行命令</Text>
        <Text color="white">2. 使用 /init 创建项目配置文件</Text>
        <Text color="white">3. 输入 /help 查看所有 slash 命令</Text>
      </Box>
    </Box>
  );
});
