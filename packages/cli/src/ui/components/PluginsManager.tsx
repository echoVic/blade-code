/**
 * PluginsManager - 插件管理器
 *
 * 显示所有已加载的插件及其详细信息
 */

import { Box, Text, useInput } from 'ink';
import { getPluginRegistry } from '../../plugins/index.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

export interface PluginsManagerProps {
  /** 完成回调 */
  onComplete?: () => void;
  /** 取消回调 */
  onCancel?: () => void;
}

/**
 * 插件管理器主组件
 */
export function PluginsManager({ onCancel }: PluginsManagerProps) {
  const registry = getPluginRegistry();
  const plugins = registry.getAll();

  // 按来源分组
  const bySource = registry.getBySource();
  const stats = registry.getStats();

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(false, onCancel);

  // ESC 和 Ctrl+C 处理
  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
    } else if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
      handleCtrlC();
    }
  });

  if (plugins.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            插件管理器
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray">没有已加载的插件</Text>
        </Box>
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          <Text color="gray">插件目录位置:</Text>
          <Text color="gray" dimColor>
            {' '}
            • ~/.blade/plugins/ - 用户级插件
          </Text>
          <Text color="gray" dimColor>
            {' '}
            • .blade/plugins/ - 项目级插件
          </Text>
          <Text color="gray" dimColor>
            {' '}
            • --plugin-dir - CLI 指定的插件
          </Text>
        </Box>
        <Box marginTop={1} paddingLeft={2}>
          <Text color="gray">使用 /plugins install &lt;url&gt; 安装新插件</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>按 ESC 返回菜单</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          插件管理器
        </Text>
        <Text color="gray"> (共 {stats.total} 个插件)</Text>
      </Box>

      {/* 统计信息 */}
      <Box paddingLeft={2} marginBottom={1}>
        <Text color="gray">
          启用: {stats.active} | 禁用: {stats.inactive} | 命令: {stats.commands} | 技能:{' '}
          {stats.skills} | 代理: {stats.agents}
        </Text>
      </Box>

      {/* CLI 指定的插件 */}
      {bySource.cli.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="magenta">
              CLI 指定
            </Text>
            <Text color="gray"> (--plugin-dir)</Text>
          </Box>
          {bySource.cli.map((plugin) => {
            const statusIcon = plugin.status === 'active' ? '[on]' : '[off]';
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    {statusIcon} {plugin.manifest.name}
                  </Text>
                  <Text color="gray"> v{plugin.manifest.version}</Text>
                </Text>
                <Box paddingLeft={2}>
                  <Text color="gray">{plugin.manifest.description}</Text>
                </Box>
                {plugin.commands.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text color="blue">
                      命令:{' '}
                      {plugin.commands.map((c) => `/${c.namespacedName}`).join(', ')}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* 项目级插件 */}
      {bySource.project.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="yellow">
              项目级
            </Text>
            <Text color="gray"> (.blade/plugins/)</Text>
          </Box>
          {bySource.project.map((plugin) => {
            const statusIcon = plugin.status === 'active' ? '[on]' : '[off]';
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    {statusIcon} {plugin.manifest.name}
                  </Text>
                  <Text color="gray"> v{plugin.manifest.version}</Text>
                </Text>
                <Box paddingLeft={2}>
                  <Text color="gray">{plugin.manifest.description}</Text>
                </Box>
                {plugin.commands.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text color="blue">
                      命令:{' '}
                      {plugin.commands.map((c) => `/${c.namespacedName}`).join(', ')}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* 用户级插件 */}
      {bySource.user.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="cyan">
              用户级
            </Text>
            <Text color="gray"> (~/.blade/plugins/)</Text>
          </Box>
          {bySource.user.map((plugin) => {
            const statusIcon = plugin.status === 'active' ? '[on]' : '[off]';
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    {statusIcon} {plugin.manifest.name}
                  </Text>
                  <Text color="gray"> v{plugin.manifest.version}</Text>
                </Text>
                <Box paddingLeft={2}>
                  <Text color="gray">{plugin.manifest.description}</Text>
                </Box>
                {plugin.commands.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text color="blue">
                      命令:{' '}
                      {plugin.commands.map((c) => `/${c.namespacedName}`).join(', ')}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1} paddingLeft={2} flexDirection="column">
        <Text color="gray">可用命令:</Text>
        <Text color="gray" dimColor>
          {' '}
          • /plugins list - 列出所有插件
        </Text>
        <Text color="gray" dimColor>
          {' '}
          • /plugins info &lt;name&gt; - 显示插件详情
        </Text>
        <Text color="gray" dimColor>
          {' '}
          • /plugins install &lt;url&gt; - 安装插件
        </Text>
        <Text color="gray" dimColor>
          {' '}
          • /plugins enable/disable &lt;name&gt; - 启用/禁用插件
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>按 ESC 返回菜单</Text>
      </Box>
    </Box>
  );
}
