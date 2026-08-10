/**
 * PluginsManager - 插件管理器
 *
 * 显示所有已加载的插件及其详细信息
 */

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { getPluginRegistry } from '../../plugins/index.js';
import {
  refreshWorkspacePlugins,
  setWorkspacePluginEnabled,
  uninstallWorkspacePlugin,
  updateWorkspacePlugin,
} from '../../plugins/PluginLifecycle.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

export interface PluginsManagerProps {
  workspaceRoot?: string;
  /** 完成回调 */
  onComplete?: () => void;
  /** 取消回调 */
  onCancel?: () => void;
}

/**
 * 插件管理器主组件
 */
export function PluginsManager({ workspaceRoot, onCancel }: PluginsManagerProps) {
  const registry = getPluginRegistry(workspaceRoot);
  const plugins = registry.getAll();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [, setRevision] = useState(0);

  // 按来源分组
  const bySource = registry.getBySource();
  const stats = registry.getStats();
  const sourcePolicy = registry.getSourcePolicy();

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(false, onCancel);

  const toggleSelected = async () => {
    const plugin = plugins[selectedIndex];
    if (!plugin || busy) return;
    if (plugin.source === 'cli') {
      setStatus(`${plugin.manifest.name} 由 --plugin-dir 管理，不能持久化切换`);
      return;
    }
    if (plugin.status === 'error') {
      setStatus(plugin.error ?? `${plugin.manifest.name} 当前不可用`);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const change = await setWorkspacePluginEnabled(
        registry.getWorkspaceRoot(),
        plugin.manifest.name,
        plugin.status !== 'active',
        'local'
      );
      setStatus(
        change.effectiveEnabled
          ? `已启用 ${plugin.manifest.name}`
          : `已禁用 ${plugin.manifest.name}`
      );
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      await refreshWorkspacePlugins(registry.getWorkspaceRoot());
      setSelectedIndex(0);
      setStatus('插件列表已刷新');
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = async () => {
    const plugin = plugins[selectedIndex];
    if (!plugin || busy) return;
    if (!plugin.installation) {
      setStatus(`${plugin.manifest.name} 不是 Blade 受管安装，不能自动更新`);
      return;
    }
    setBusy(true);
    setConfirmingRemoval(null);
    setStatus('');
    try {
      const { result } = await updateWorkspacePlugin(
        registry.getWorkspaceRoot(),
        plugin.manifest.name,
        { trusted: true }
      );
      if (!result.success) throw new Error(result.error);
      setStatus(
        result.changed
          ? `已更新 ${plugin.manifest.name} 到 ${result.installation?.revision}`
          : `${plugin.manifest.name} 已是最新版本`
      );
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    const plugin = plugins[selectedIndex];
    if (!plugin || busy) return;
    if (!plugin.installation) {
      setStatus(`${plugin.manifest.name} 不是 Blade 受管安装，不能自动卸载`);
      return;
    }
    if (confirmingRemoval !== plugin.manifest.name) {
      setConfirmingRemoval(plugin.manifest.name);
      setStatus(`再次按 x 确认卸载 ${plugin.manifest.name}`);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const { result } = await uninstallWorkspacePlugin(
        registry.getWorkspaceRoot(),
        plugin.manifest.name,
        true
      );
      if (!result.success) throw new Error(result.error);
      setConfirmingRemoval(null);
      setSelectedIndex(0);
      setStatus(`已卸载 ${plugin.manifest.name}`);
      setRevision((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
    } else if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
      handleCtrlC();
    } else if ((key.upArrow || input === 'k') && plugins.length > 0) {
      setConfirmingRemoval(null);
      setSelectedIndex((index) => (index - 1 + plugins.length) % plugins.length);
    } else if ((key.downArrow || input === 'j') && plugins.length > 0) {
      setConfirmingRemoval(null);
      setSelectedIndex((index) => (index + 1) % plugins.length);
    } else if (input === ' ' || key.return) {
      void toggleSelected();
    } else if (input === 'r') {
      void refresh();
    } else if (input === 'u') {
      void updateSelected();
    } else if (input === 'x') {
      void removeSelected();
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
      <Box paddingLeft={2} marginBottom={1}>
        <Text color="gray">
          来源策略: {sourcePolicy.restrictToAllowedSources ? 'restricted' : 'open'} |
          Git SHA: {sourcePolicy.requireGitCommitSha ? 'required' : 'optional'}
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
            const selected = plugins.indexOf(plugin) === selectedIndex;
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color={selected ? 'cyan' : 'green'}>
                    {selected ? '› ' : '  '}
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
            const selected = plugins.indexOf(plugin) === selectedIndex;
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color={selected ? 'cyan' : 'green'}>
                    {selected ? '› ' : '  '}
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
            const selected = plugins.indexOf(plugin) === selectedIndex;
            return (
              <Box key={plugin.manifest.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color={selected ? 'cyan' : 'green'}>
                    {selected ? '› ' : '  '}
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
        <Text color="gray" dimColor>
          {' '}
          • /plugins policy show|set - 来源与 SHA 策略
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ 选择 · Space/Enter 启停 · u 信任并更新 · x 卸载 · r 刷新 · ESC 返回
        </Text>
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color={status.includes('失败') ? 'red' : 'cyan'}>{status}</Text>
        </Box>
      )}
      {busy && <Text color="gray">处理中...</Text>}
    </Box>
  );
}
