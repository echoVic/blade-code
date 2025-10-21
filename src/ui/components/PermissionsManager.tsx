import { useMemoizedFn } from 'ahooks';
import { promises as fs } from 'fs';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import os from 'os';
import path from 'path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import type { PermissionConfig } from '../../config/types.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

type RuleSource = 'local' | 'project' | 'global';
type PermissionType = 'allow' | 'ask' | 'deny';
type TabKey = PermissionType | 'info';
type ViewMode = 'list' | 'add' | 'confirm-delete' | 'locked';

interface RuleEntry {
  key: string;
  rule: string;
  source: RuleSource;
}

type RuleSelectValue = { type: 'add' } | { type: 'rule'; entry: RuleEntry };

type RuleSelectItem = {
  label: string;
  value: RuleSelectValue;
};

interface PermissionEntries {
  allow: RuleEntry[];
  ask: RuleEntry[];
  deny: RuleEntry[];
}

interface SourceStatus {
  localExists: boolean;
  projectExists: boolean;
  globalExists: boolean;
}

interface PermissionsManagerProps {
  onClose: () => void;
}

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'allow', label: 'Allow' },
  { key: 'ask', label: 'Ask' },
  { key: 'deny', label: 'Deny' },
  { key: 'info', label: 'Info' },
];

const addLabels: Record<PermissionType, string> = {
  allow: 'Add a new rule...',
  ask: 'Add a new rule...',
  deny: 'Add a new rule...',
};

const tabTitles: Record<PermissionType, string> = {
  allow: 'Allow permission rules',
  ask: 'Ask permission rules',
  deny: 'Deny permission rules',
};

const sourceLabels: Record<RuleSource, string> = {
  project: '[项目共享配置]',
  global: '[用户全局配置]',
  local: '[本地配置]',
};

const sourceOrder: RuleSource[] = ['project', 'global', 'local'];

const initialEntries: PermissionEntries = {
  allow: [],
  ask: [],
  deny: [],
};

const defaultStatus: SourceStatus = {
  localExists: false,
  projectExists: false,
  globalExists: false,
};

const defaultPermissions: PermissionConfig = { allow: [], ask: [], deny: [] };

function normalizePermissions(input: unknown): PermissionConfig {
  const ensure = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];

  const source = (input as { [key: string]: unknown })?.permissions ?? {};
  return {
    allow: ensure((source as PermissionConfig)?.allow),
    ask: ensure((source as PermissionConfig)?.ask),
    deny: ensure((source as PermissionConfig)?.deny),
  };
}

async function readSettingsFile(filePath: string): Promise<{
  exists: boolean;
  raw: any;
  permissions: PermissionConfig;
}> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);
    return {
      exists: true,
      raw,
      permissions: normalizePermissions(raw),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, raw: {}, permissions: { ...defaultPermissions } };
    }
    console.warn(`[PermissionsManager] Failed to read ${filePath}:`, error);
    return { exists: true, raw: {}, permissions: { ...defaultPermissions } };
  }
}

function formatRuleLabel(rule: string, source: RuleSource): string {
  const padding = rule.padEnd(32, ' ');
  const suffix =
    source === 'local' ? `${sourceLabels[source]} ← 可删除` : sourceLabels[source];
  return `${padding} ${suffix}`;
}

export const PermissionsManager: React.FC<PermissionsManagerProps> = ({ onClose }) => {
  // 使用 FocusContext 管理焦点
  const { state: focusState } = useFocusContext();
  const isFocused = focusState.currentFocus === FocusId.PERMISSIONS_MANAGER;

  // 使用智能 Ctrl+C 处理（没有任务，所以直接退出）
  const handleCtrlC = useCtrlCHandler(false);

  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTab = tabs[activeTabIndex].key;
  const [entries, setEntries] = useState<PermissionEntries>(initialEntries);
  const [status, setStatus] = useState<SourceStatus>(defaultStatus);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>('list');
  const [inputValue, setInputValue] = useState('');
  const [selectedRule, setSelectedRule] = useState<{
    tab: Exclude<TabKey, 'info'>;
    entry: RuleEntry;
  } | null>(null);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const lockedAwaitRef = useRef(false);

  const localSettingsPath = useMemo(
    () => path.join(process.cwd(), '.blade', 'settings.local.json'),
    []
  );
  const projectSettingsPath = useMemo(
    () => path.join(process.cwd(), '.blade', 'settings.json'),
    []
  );
  const globalSettingsPath = useMemo(
    () => path.join(os.homedir(), '.blade', 'settings.json'),
    []
  );

  const loadPermissions = useMemoizedFn(async () => {
    setLoading(true);
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();

    const sources: Array<{ source: RuleSource; path: string }> = [
      { source: 'local', path: localSettingsPath },
      { source: 'project', path: projectSettingsPath },
      { source: 'global', path: globalSettingsPath },
    ];

    const results = await Promise.all(
      sources.map(async ({ source, path: filePath }) => {
        const data = await readSettingsFile(filePath);
        return { source, path: filePath, ...data };
      })
    );

    const statusSnapshot: SourceStatus = {
      localExists: results.find((item) => item.source === 'local')?.exists ?? false,
      projectExists: results.find((item) => item.source === 'project')?.exists ?? false,
      globalExists: results.find((item) => item.source === 'global')?.exists ?? false,
    };
    setStatus(statusSnapshot);

    const nextEntries: PermissionEntries = {
      allow: [],
      ask: [],
      deny: [],
    };
    const resultMap = Object.fromEntries(
      results.map((item) => [item.source, item] as const)
    );

    (['allow', 'ask', 'deny'] as PermissionType[]).forEach((key) => {
      sourceOrder.forEach((source) => {
        const rules = resultMap[source]?.permissions[key] ?? [];
        rules.forEach((rule, index) => {
          const entry: RuleEntry = {
            key: `${source}:${index}:${rule}`,
            rule,
            source,
          };
          nextEntries[key].push(entry);
        });
      });
    });

    const aggregated = configManager.getConfig();
    aggregated.permissions.allow = Array.from(
      new Set(nextEntries.allow.map((entry) => entry.rule))
    );
    aggregated.permissions.ask = Array.from(
      new Set(nextEntries.ask.map((entry) => entry.rule))
    );
    aggregated.permissions.deny = Array.from(
      new Set(nextEntries.deny.map((entry) => entry.rule))
    );

    setEntries(nextEntries);
    setLoading(false);
  });

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  const modifyLocalPermissions = useMemoizedFn(
    async (
      tab: Exclude<TabKey, 'info'>,
      mutator: (permissions: PermissionConfig) => PermissionConfig
    ) => {
      let settingsRaw: any = {};
      let currentPermissions: PermissionConfig = { ...defaultPermissions };

      try {
        const content = await fs.readFile(localSettingsPath, 'utf-8');
        settingsRaw = JSON.parse(content);
        currentPermissions = normalizePermissions(settingsRaw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        settingsRaw = {};
      }

      const updated = mutator(currentPermissions);
      settingsRaw.permissions = {
        allow: updated.allow,
        ask: updated.ask,
        deny: updated.deny,
      };

      await fs.writeFile(localSettingsPath, JSON.stringify(settingsRaw, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });

      await loadPermissions();
    }
  );

  // 处理键盘输入
  useInput(
    (input, key) => {
      // Ctrl+C 或 Cmd+C: 智能退出应用
      if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
        return;
      }

      if (mode === 'locked') {
        if (lockedAwaitRef.current) {
          lockedAwaitRef.current = false;
          return;
        }
        setMode('list');
        setSelectedRule(null);
        setMessage(null);
        return;
      }

      if (key.escape) {
        if (mode === 'list' || activeTab === 'info') {
          onClose();
        } else {
          setMode('list');
          setInputValue('');
          setSelectedRule(null);
          setMessage(null);
        }
        return;
      }

      if (mode === 'list') {
        if (key.tab && key.shift) {
          setActiveTabIndex((index) => (index - 1 + tabs.length) % tabs.length);
        } else if (key.tab) {
          setActiveTabIndex((index) => (index + 1) % tabs.length);
        } else if (input?.toLowerCase() === 'q') {
          onClose();
        }
      }
    },
    { isActive: isFocused }
  );

  const handleRuleSelect = useMemoizedFn((item: RuleSelectItem) => {
    const value = item.value;
    if (activeTab === 'info') {
      return;
    }

    if (value.type === 'add') {
      setMode('add');
      setInputValue('');
      setMessage(null);
      return;
    }

    if (value.entry.source !== 'local') {
      setMode('locked');
      lockedAwaitRef.current = true;
      setSelectedRule({
        tab: activeTab as Exclude<TabKey, 'info'>,
        entry: value.entry,
      });
      setMessage({
        type: 'error',
        text:
          value.entry.source === 'project'
            ? '此规则定义在项目共享配置中，无法在此删除。'
            : '此规则来自用户全局配置，无法在此删除。',
      });
      return;
    }

    setMode('confirm-delete');
    setSelectedRule({
      tab: activeTab as Exclude<TabKey, 'info'>,
      entry: value.entry,
    });
    setMessage(null);
  });

  const handleAddRule = useMemoizedFn(async () => {
    if (activeTab === 'info') return;
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setMessage({ type: 'error', text: 'Permission rule 不能为空' });
      return;
    }

    const currentEntries = entries[activeTab as Exclude<TabKey, 'info'>].map(
      (item) => item.rule
    );
    if (currentEntries.includes(trimmed)) {
      setMessage({ type: 'error', text: '该规则已存在' });
      return;
    }

    try {
      await modifyLocalPermissions(
        activeTab as Exclude<TabKey, 'info'>,
        (permissions) => {
          const next: PermissionConfig = {
            allow: [...permissions.allow],
            ask: [...permissions.ask],
            deny: [...permissions.deny],
          };
          next[activeTab as Exclude<TabKey, 'info'>] = [
            ...new Set([...permissions[activeTab as Exclude<TabKey, 'info'>], trimmed]),
          ];
          return next;
        }
      );

      setMode('list');
      setInputValue('');
      setMessage({ type: 'success', text: '已添加本地权限规则' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `保存失败: ${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  });

  const handleDeleteRule = useMemoizedFn(async () => {
    if (!selectedRule) return;

    const { tab, entry } = selectedRule;
    try {
      await modifyLocalPermissions(tab, (permissions) => {
        const next: PermissionConfig = {
          allow: [...permissions.allow],
          ask: [...permissions.ask],
          deny: [...permissions.deny],
        };
        next[tab] = permissions[tab].filter((rule) => rule !== entry.rule);
        return next;
      });

      setMode('list');
      setSelectedRule(null);
      setMessage({ type: 'success', text: '已删除本地权限规则' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `删除失败: ${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  });

  const listItems = useMemo((): RuleSelectItem[] => {
    if (activeTab === 'info') return [];
    const tabKey = activeTab as Exclude<TabKey, 'info'>;
    const items: RuleSelectItem[] = [
      {
        label: `› ${addLabels[tabKey]}`,
        value: { type: 'add' },
      },
      ...entries[tabKey].map(
        (entry): RuleSelectItem => ({
          label: formatRuleLabel(entry.rule, entry.source),
          value: { type: 'rule', entry },
        })
      ),
    ];
    return items;
  }, [activeTab, entries]);

  const renderTabHeader = () => (
    <Box marginBottom={1}>
      {tabs.map((tab, index) => (
        <Box key={tab.key} marginRight={2}>
          <Text color={index === activeTabIndex ? 'yellow' : 'gray'}>
            [{tab.label}]
          </Text>
        </Box>
      ))}
    </Box>
  );

  const renderInfoView = () => (
    <Box flexDirection="column" gap={1}>
      <Text>配置文件优先级（从高到低）：</Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          1. .blade/settings.local.json (本地配置，不提交 Git){' '}
          {status.localExists ? '✓ 存在' : '✗ 不存在'}
        </Text>
        <Text>
          2. .blade/settings.json (项目配置，提交 Git){' '}
          {status.projectExists ? '✓ 存在' : '✗ 不存在'}
        </Text>
        <Text>
          3. ~/.blade/settings.json (用户全局配置){' '}
          {status.globalExists ? '✓ 存在' : '✗ 不存在'}
        </Text>
      </Box>
      <Text>说明：</Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text>- /permissions 命令只管理本地配置 (.blade/settings.local.json)</Text>
        <Text>- 修改全局或项目配置请直接编辑对应文件</Text>
        <Text>- 本地配置不会提交到 Git</Text>
      </Box>
    </Box>
  );

  const renderAddView = (tab: Exclude<TabKey, 'info'>) => (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tabTitles[tab]}</Text>
      <Text>
        Permission rules are a tool name, optionally followed by a specifier in
        parentheses.
      </Text>
      <Text color="gray">例如: WebFetch 或 Bash(ls:*)</Text>
      <Box marginTop={1}>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleAddRule}
        />
      </Box>
      <Text color="gray">Enter 提交 · Esc 取消</Text>
    </Box>
  );

  const renderDeleteConfirm = (tab: Exclude<TabKey, 'info'>, entry: RuleEntry) => (
    <Box flexDirection="column" gap={1}>
      <Text bold>Delete {tab} permission rule?</Text>
      <Text>{entry.rule}</Text>
      <Text color="gray">From project local settings</Text>
      <Text>Are you sure you want to delete this permission rule?</Text>
      <SelectInput
        items={[
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        onSelect={(item) => {
          if (item.value === 'yes') {
            void handleDeleteRule();
          } else {
            setMode('list');
            setSelectedRule(null);
          }
        }}
      />
    </Box>
  );

  const renderLockedMessage = (entry: RuleEntry) => (
    <Box flexDirection="column" gap={1}>
      <Text bold>Cannot delete this rule</Text>
      <Text>{entry.rule}</Text>
      <Text color="gray">
        {entry.source === 'project'
          ? 'This rule is defined in .blade/settings.json. 请手动编辑该文件以移除规则。'
          : 'This rule is defined in ~/.blade/settings.json. 请手动编辑该文件以移除规则。'}
      </Text>
      <Text color="gray">按任意键继续</Text>
    </Box>
  );

  const renderListView = (tab: Exclude<TabKey, 'info'>) => (
    <SelectInput
      items={listItems}
      isFocused={mode === 'list'}
      onSelect={handleRuleSelect}
    />
  );

  const renderContent = () => {
    if (loading) {
      return <Text>加载中...</Text>;
    }

    if (activeTab === 'info') {
      return renderInfoView();
    }

    if (mode === 'add') {
      return renderAddView(activeTab as Exclude<TabKey, 'info'>);
    }

    if (mode === 'confirm-delete' && selectedRule) {
      return renderDeleteConfirm(selectedRule.tab, selectedRule.entry);
    }

    if (mode === 'locked' && selectedRule) {
      return renderLockedMessage(selectedRule.entry);
    }

    return renderListView(activeTab as Exclude<TabKey, 'info'>);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      padding={1}
      width={80}
    >
      <Text color="cyan" bold>
        ⚙️ 权限管理器
      </Text>
      {renderTabHeader()}
      <Box flexDirection="column" gap={1}>
        {renderContent()}
      </Box>
      {message && (
        <Box marginTop={1}>
          <Text color={message.type === 'success' ? 'green' : 'red'}>
            {message.text}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">Tab 切换视图 · Esc 关闭 · Q 退出</Text>
      </Box>
    </Box>
  );
};
