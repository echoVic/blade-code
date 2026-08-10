import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DEFAULT_COMMUNICATION_STYLES } from '@/lib/communicationStyles';
import { requestJson } from '@/lib/http';
import {
  KEYBOARD_SHORTCUTS,
  type ShortcutId,
  shortcutKeyLabels,
} from '@/lib/keyboardShortcuts';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { type SettingsSection, useAppStore } from '@/store/AppStore';
import { type ModelConfig, useConfigStore } from '@/store/ConfigStore';
import { useSettingsStore } from '@/store/SettingsStore';
import { AddModelModal, type ModelFormData } from './AddModelModal';
import { EditModelModal } from './EditModelModal';
import {
  EditProviderModal,
  type ProviderChannel,
  type ProviderChannelUpdate,
} from './EditProviderModal';
import { HookTrustPanel } from './HookTrustPanel';
import { PluginPanel } from './PluginPanel';
import { WorkspaceTrustPanel } from './WorkspaceTrustPanel';

type TabValue = SettingsSection;

interface ProviderProbeResult {
  ok: boolean;
  providerId: string;
  modelConfigId: string;
  model: string;
  wireApi: string;
  latencyMs: number;
  code: string;
  message: string;
}

const PROVIDER_ICONS: Record<string, { bg: string; label: string }> = {
  anthropic: { bg: '#d97757', label: 'A' },
  gemini: { bg: '#4285f4', label: 'G' },
  'azure-openai': { bg: '#0078d4', label: 'Az' },
  'gpt-openai-platform': { bg: '#10a37f', label: 'GP' },
};

const SHORTCUT_ACTION_LABELS: Record<ShortcutId, string> = {
  searchTasks: 'Search tasks',
  openCommands: 'Open command center',
  newTask: 'New task',
  focusComposer: 'Focus composer',
  toggleSidebar: 'Toggle sidebar',
};

export function SettingsModal() {
  const {
    isSettingsOpen,
    settingsSection,
    toggleSettings,
    isSidebarOpen,
    setSidebarOpen,
  } = useAppStore();
  const {
    configuredModels,
    loadModels,
    isLoading: modelsLoading,
    error: modelsError,
  } = useConfigStore();
  const settings = useSettingsStore();
  const [activeTab, setActiveTab] = useState<TabValue>('general');
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelConfig | null>(null);
  const [providerChannels, setProviderChannels] = useState<ProviderChannel[]>([]);
  const [editingProvider, setEditingProvider] = useState<ProviderChannel | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<ProviderChannel | null>(null);
  const [providerAction, setProviderAction] = useState<{
    providerId: string;
    type: 'probe' | 'update' | 'delete';
  } | null>(null);
  const [providerActionError, setProviderActionError] = useState<string | null>(null);
  const [providerProbes, setProviderProbes] = useState<
    Record<string, ProviderProbeResult>
  >({});
  const [modelAction, setModelAction] = useState<'save' | 'update' | 'delete' | null>(
    null
  );
  const [modelActionError, setModelActionError] = useState<string | null>(null);
  const [shortcutQuery, setShortcutQuery] = useState('');
  const [shortcutScope, setShortcutScope] = useState<
    'all' | 'global' | 'chat' | 'layout'
  >('all');
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const nestedModalClosedAtRef = useRef(0);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  const tabs: { value: TabValue; label: string; category: string }[] = [
    { value: 'general', label: 'General', category: 'Settings' },
    { value: 'trust', label: 'Security', category: 'Settings' },
    { value: 'models', label: 'Models', category: 'Settings' },
    { value: 'shortcuts', label: 'Shortcuts', category: 'Settings' },
    { value: 'mcp', label: 'MCP', category: 'Integrations' },
    { value: 'skills', label: 'Skills', category: 'Integrations' },
    { value: 'plugins', label: 'Plugins', category: 'Integrations' },
    { value: 'hooks', label: 'Hooks', category: 'Integrations' },
  ];

  const shortcuts = useMemo(
    () =>
      KEYBOARD_SHORTCUTS.map((shortcut) => ({
        action: SHORTCUT_ACTION_LABELS[shortcut.id],
        combo: shortcutKeyLabels(shortcut),
        scope: shortcut.scope,
      })),
    []
  );

  const filteredShortcuts = shortcuts.filter((shortcut) => {
    const matchesQuery = shortcut.action
      .toLowerCase()
      .includes(shortcutQuery.toLowerCase());
    const matchesScope =
      shortcutScope === 'all' || shortcut.scope.toLowerCase() === shortcutScope;
    return matchesQuery && matchesScope;
  });

  const groupedModels = configuredModels.reduce(
    (acc, model) => {
      const provider = model.provider || 'unknown';
      if (!acc[provider]) {
        acc[provider] = [];
      }
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, typeof configuredModels>
  );
  const providerById = new Map(
    providerChannels.map((provider) => [provider.id, provider])
  );
  for (const provider of providerChannels) {
    if (provider.custom && !groupedModels[provider.id]) {
      groupedModels[provider.id] = [];
    }
  }

  const loadProviderChannels = useCallback(async () => {
    try {
      setProviderChannels(await requestJson<ProviderChannel[]>('/providers'));
      setProviderActionError(null);
    } catch (error) {
      setProviderActionError(
        error instanceof Error ? error.message : 'Failed to load provider channels'
      );
    }
  }, []);

  useEffect(() => {
    if (isSettingsOpen) {
      setActiveTab(settingsSection);
      loadModels();
      void loadProviderChannels();
      settings.loadSettings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isSettingsOpen,
    loadModels,
    loadProviderChannels,
    settings.loadSettings,
    settingsSection,
  ]);

  const restoreSettingsFocus = () => {
    const returnFocus = returnFocusRef.current;
    const target = returnFocus?.isConnected
      ? returnFocus
      : document.querySelector<HTMLElement>('[data-settings-trigger]');
    target?.focus({ preventScroll: true });
  };

  const closeSettings = () => {
    toggleSettings();
    requestAnimationFrame(restoreSettingsFocus);
  };

  useLayoutEffect(() => {
    if (!isSettingsOpen) return;
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (
      activeElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement &&
      !activeElement.closest('[data-settings-panel]')
    ) {
      returnFocusRef.current = activeElement;
    }
    const focusFrame = requestAnimationFrame(() => {
      backButtonRef.current?.focus({ preventScroll: true });
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      requestAnimationFrame(restoreSettingsFocus);
    };
  }, [isSettingsOpen]);

  const handleSaveModel = async (formData: ModelFormData): Promise<boolean> => {
    setModelAction('save');
    setModelActionError(null);
    try {
      await requestJson('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: formData.provider,
          displayName: formData.displayName,
          model: formData.model,
          apiKey: formData.apiKey,
          modelProvider: formData.modelProvider,
          overrides: formData.overrides,
        }),
      });
      await loadModels();
      await loadProviderChannels();
      return true;
    } catch (err) {
      setModelActionError(err instanceof Error ? err.message : 'Failed to save model');
      return false;
    } finally {
      setModelAction(null);
    }
  };

  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    setNotificationPermission(await Notification.requestPermission());
  };

  const handleDeleteModel = async (modelId: string) => {
    setModelAction('delete');
    setModelActionError(null);
    try {
      await requestJson(`/models/${modelId}`, { method: 'DELETE' });
      await loadModels();
      setDeleteModel(null);
    } catch (err) {
      setModelActionError(
        err instanceof Error ? err.message : 'Failed to delete model'
      );
    } finally {
      setModelAction(null);
    }
  };

  const handleUpdateModel = async (
    modelId: string,
    updates: Partial<ModelConfig>
  ): Promise<boolean> => {
    setModelAction('update');
    setModelActionError(null);
    try {
      await requestJson(`/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      await loadModels();
      return true;
    } catch (err) {
      setModelActionError(
        err instanceof Error ? err.message : 'Failed to update model'
      );
      return false;
    } finally {
      setModelAction(null);
    }
  };

  const handleUpdateProvider = async (
    providerId: string,
    update: ProviderChannelUpdate
  ): Promise<boolean> => {
    setProviderAction({ providerId, type: 'update' });
    setProviderActionError(null);
    try {
      await requestJson(`/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      await Promise.all([loadModels(), loadProviderChannels()]);
      return true;
    } catch (error) {
      setProviderActionError(
        error instanceof Error ? error.message : 'Failed to update provider channel'
      );
      return false;
    } finally {
      setProviderAction(null);
    }
  };

  const handleProbeProvider = async (provider: ProviderChannel, modelId?: string) => {
    setProviderAction({ providerId: provider.id, type: 'probe' });
    setProviderActionError(null);
    try {
      const result = await requestJson<ProviderProbeResult>(
        `/providers/${provider.id}/probe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId }),
        }
      );
      setProviderProbes((current) => ({
        ...current,
        [provider.id]: result,
      }));
    } catch (error) {
      setProviderActionError(
        error instanceof Error ? error.message : 'Provider probe failed'
      );
    } finally {
      setProviderAction(null);
    }
  };

  const handleDeleteProvider = async (provider: ProviderChannel) => {
    setProviderAction({ providerId: provider.id, type: 'delete' });
    setProviderActionError(null);
    try {
      await requestJson(`/providers/${provider.id}?removeModels=true`, {
        method: 'DELETE',
      });
      setDeleteProvider(null);
      setExpandedProvider(null);
      setProviderProbes((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      await Promise.all([loadModels(), loadProviderChannels()]);
    } catch (error) {
      setProviderActionError(
        error instanceof Error ? error.message : 'Failed to delete provider channel'
      );
    } finally {
      setProviderAction(null);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return;

    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + direction + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIndex].value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [nextIndex]?.focus();
  };

  const toggleProvider = (provider: string) => {
    setExpandedProvider(expandedProvider === provider ? null : provider);
  };

  const handleSettingsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isSettingsOpen || event.key !== 'Escape') return;
    if (
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    ) {
      return;
    }
    if (
      addModelOpen ||
      editingModel ||
      editingProvider ||
      Date.now() - nestedModalClosedAtRef.current < 250
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || target?.closest('[role="dialog"]')) return;
    event.preventDefault();
    if (deleteModel) {
      setDeleteModel(null);
      return;
    }
    if (deleteProvider) {
      setDeleteProvider(null);
      return;
    }
    closeSettings();
  };

  return (
    <>
      <div
        data-settings-panel
        onKeyDown={handleSettingsKeyDown}
        className="flex h-full min-h-0 bg-white dark:bg-[#09090b]"
      >
        {/* Left navigation sidebar */}
        <nav
          role="tablist"
          aria-label="Settings sections"
          className="flex h-full w-[220px] shrink-0 flex-col border-r border-[#E5E7EB] bg-[#F9FAFB] dark:border-zinc-800 dark:bg-[#111113]"
        >
          <div className="shrink-0 p-4">
            <button
              ref={backButtonRef}
              type="button"
              onClick={closeSettings}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-mono text-[#6B7280] transition-colors hover:bg-[#E5E7EB] hover:text-[#111827] dark:text-[#a1a1aa] dark:hover:bg-[#27272a] dark:hover:text-[#E5E5E5]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-4">
            {Object.entries(
              tabs.reduce(
                (acc, tab) => {
                  if (!acc[tab.category]) acc[tab.category] = [];
                  acc[tab.category].push(tab);
                  return acc;
                },
                {} as Record<string, typeof tabs>
              )
            ).map(([category, categoryTabs]) => (
              <div key={category} className="mb-4">
                <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] dark:text-[#71717a]">
                  {category}
                </div>
                {categoryTabs.map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => setActiveTab(tab.value)}
                    onKeyDown={(event) => handleTabKeyDown(event, tabs.indexOf(tab))}
                    role="tab"
                    id={`settings-tab-${tab.value}`}
                    aria-controls={`settings-panel-${tab.value}`}
                    aria-selected={activeTab === tab.value}
                    tabIndex={activeTab === tab.value ? 0 : -1}
                    className={cn(
                      'w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors',
                      activeTab === tab.value
                        ? 'bg-[#E5E7EB] font-medium text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5]'
                        : 'text-[#6B7280] hover:bg-[#E5E7EB]/60 hover:text-[#111827] dark:text-[#a1a1aa] dark:hover:bg-[#27272a]/50 dark:hover:text-[#E5E5E5]'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>

        {/* Right content panel */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 sm:p-10">
            <div className="mx-auto max-w-2xl">
              <h1 className="mb-6 text-xl font-semibold text-[#111827] dark:text-[#E5E5E5]">
                {tabs.find((tab) => tab.value === activeTab)?.label ?? 'Settings'}
              </h1>

              {settings.isLoading && activeTab === 'general' && (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading settings...
                </div>
              )}
              {settings.error && activeTab === 'general' && (
                <div
                  role="alert"
                  className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{settings.error}</span>
                  <button
                    type="button"
                    onClick={() => void settings.loadSettings()}
                    className="shrink-0 underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {activeTab === 'models' && (
                <div
                  id="settings-panel-models"
                  role="tabpanel"
                  aria-labelledby="settings-tab-models"
                  className="flex flex-col gap-6 flex-1 min-h-0 overflow-hidden"
                >
                  <p className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono shrink-0">
                    Configure API keys and model settings for different providers.
                  </p>

                  {(modelsError || modelActionError || providerActionError) && (
                    <div
                      role="alert"
                      className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                    >
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {providerActionError || modelActionError || modelsError}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setModelActionError(null);
                          setProviderActionError(null);
                          if (modelsError) void loadModels();
                        }}
                        className="shrink-0 underline"
                      >
                        {modelsError ? 'Retry' : 'Dismiss'}
                      </button>
                    </div>
                  )}

                  {deleteModel && (
                    <div
                      role="alertdialog"
                      aria-label={`Delete ${deleteModel.displayName || deleteModel.model}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/30"
                    >
                      <span className="text-[11px] font-mono text-red-700 dark:text-red-300">
                        Delete {deleteModel.displayName || deleteModel.model} and its
                        saved configuration?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setDeleteModel(null)}
                          className="h-7 rounded-md px-2.5 text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteModel(deleteModel.id)}
                          disabled={modelAction !== null}
                          className="h-7 rounded-md bg-red-600 px-2.5 text-[11px] font-mono font-semibold text-white disabled:opacity-60"
                        >
                          {modelAction === 'delete' ? 'Deleting...' : 'Delete model'}
                        </button>
                      </div>
                    </div>
                  )}

                  {deleteProvider && (
                    <div
                      role="alertdialog"
                      aria-label={`Delete channel ${deleteProvider.name}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/30"
                    >
                      <span className="text-[11px] font-mono text-red-700 dark:text-red-300">
                        Delete channel {deleteProvider.name}, its credential, and{' '}
                        {groupedModels[deleteProvider.id]?.length ?? 0} configured
                        model(s)? Fallback references will also be removed.
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setDeleteProvider(null)}
                          className="h-7 rounded-md px-2.5 text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteProvider(deleteProvider)}
                          disabled={providerAction !== null}
                          className="h-7 rounded-md bg-red-600 px-2.5 text-[11px] font-mono font-semibold text-white disabled:opacity-60"
                        >
                          {providerAction?.type === 'delete'
                            ? 'Deleting...'
                            : 'Delete channel'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto min-h-0">
                    <div className="flex flex-col gap-2 pr-2">
                      {modelsLoading && configuredModels.length === 0 && (
                        <div
                          role="status"
                          className="flex items-center justify-center gap-2 py-8 text-sm font-mono text-[#9CA3AF] dark:text-[#71717a]"
                        >
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading models...
                        </div>
                      )}
                      {Object.entries(groupedModels).map(([provider, models]) => {
                        const iconInfo = PROVIDER_ICONS[provider] || {
                          bg: '#71717a',
                          label: '?',
                        };
                        const channel = providerById.get(provider);
                        const isExpanded = expandedProvider === provider;
                        const probe = providerProbes[provider];
                        const probing =
                          providerAction?.providerId === provider &&
                          providerAction.type === 'probe';

                        return (
                          <div
                            key={provider}
                            className="w-full bg-[#F3F4F6] dark:bg-[#18181b] rounded-lg overflow-hidden"
                          >
                            <div className="flex items-center">
                              <button
                                onClick={() => toggleProvider(provider)}
                                className="flex min-w-0 flex-1 items-center justify-between p-4 text-left transition-colors hover:bg-[#E5E7EB] dark:hover:bg-[#1f1f23]"
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <div
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs font-bold text-white"
                                    style={{ backgroundColor: iconInfo.bg }}
                                  >
                                    {iconInfo.label}
                                  </div>
                                  <div className="flex min-w-0 flex-col gap-0.5 text-left">
                                    <span className="truncate text-sm font-semibold font-mono text-[#111827] dark:text-[#E5E5E5]">
                                      {channel?.name ?? provider.replace(/-/g, ' ')}
                                    </span>
                                    <span className="truncate text-xs font-mono text-[#9CA3AF] dark:text-[#71717a]">
                                      {models.length} model
                                      {models.length !== 1 ? 's' : ''}
                                      {channel?.custom ? ` · ${channel.wireApi}` : ''}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-3">
                                  <span
                                    className={cn(
                                      'text-xs font-mono',
                                      channel?.configured === false
                                        ? 'text-amber-600'
                                        : 'text-[#16A34A]'
                                    )}
                                  >
                                    ●{' '}
                                    {channel?.configured === false
                                      ? 'Missing credential'
                                      : 'Configured'}
                                  </span>
                                  <ChevronDown
                                    className={cn(
                                      'h-4 w-4 text-[#9CA3AF] transition-transform dark:text-[#71717a]',
                                      isExpanded && 'rotate-180'
                                    )}
                                  />
                                </div>
                              </button>
                              {channel?.custom && (
                                <div className="flex shrink-0 items-center gap-1 pr-3">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleProbeProvider(channel, models[0]?.id)
                                    }
                                    disabled={
                                      providerAction !== null || models.length === 0
                                    }
                                    aria-label={`Test ${channel.name}`}
                                    className="rounded p-1.5 text-[#71717a] hover:bg-[#E5E7EB] hover:text-[#111827] disabled:opacity-50 dark:hover:bg-[#27272a] dark:hover:text-[#E5E5E5]"
                                  >
                                    {probing ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Activity className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    data-edit-provider-trigger={channel.id}
                                    onClick={() => {
                                      setProviderActionError(null);
                                      setEditingProvider(channel);
                                    }}
                                    disabled={providerAction !== null}
                                    aria-label={`Edit channel ${channel.name}`}
                                    className="rounded p-1.5 text-[#71717a] hover:bg-[#E5E7EB] hover:text-[#111827] disabled:opacity-50 dark:hover:bg-[#27272a] dark:hover:text-[#E5E5E5]"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeleteProvider(channel)}
                                    disabled={providerAction !== null}
                                    aria-label={`Delete channel ${channel.name}`}
                                    className="rounded p-1.5 text-[#71717a] hover:bg-[#E5E7EB] hover:text-red-500 disabled:opacity-50 dark:hover:bg-[#27272a] dark:hover:text-red-400"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>

                            {probe && (
                              <div
                                role="status"
                                className={cn(
                                  'border-t px-4 py-2 font-mono text-[11px]',
                                  probe.ok
                                    ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-300'
                                    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300'
                                )}
                              >
                                {probe.message} · {probe.latencyMs}ms · {probe.wireApi}
                              </div>
                            )}

                            {isExpanded && (
                              <div className="border-t border-[#E5E7EB] dark:border-zinc-800">
                                {channel?.custom && (
                                  <div className="border-b border-[#E5E7EB] px-4 py-2 font-mono text-[11px] text-[#71717a] dark:border-zinc-800">
                                    <span className="font-semibold">{channel.id}</span>{' '}
                                    · {channel.defaultBaseUrl}
                                  </div>
                                )}
                                {models.map((model) => (
                                  <div
                                    key={model.id}
                                    className="px-4 py-3 flex items-center justify-between hover:bg-[#E5E7EB] dark:hover:bg-[#1f1f23] group"
                                  >
                                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                                      <span className="text-sm text-[#111827] dark:text-[#E5E5E5] font-mono truncate">
                                        {model.displayName || model.model}
                                      </span>
                                      <span className="text-xs text-[#9CA3AF] dark:text-[#71717a] font-mono truncate">
                                        {model.displayName && `${model.model} · `}
                                        {model.overrides?.baseUrl || 'default endpoint'}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                      <button
                                        data-edit-model-trigger={model.id}
                                        onClick={() => {
                                          setModelActionError(null);
                                          setEditingModel(model);
                                        }}
                                        disabled={modelAction !== null}
                                        aria-label={`Edit ${model.displayName || model.model}`}
                                        className="p-1.5 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] rounded transition-colors"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        onClick={() => setDeleteModel(model)}
                                        disabled={modelAction !== null}
                                        aria-label={`Delete ${model.displayName || model.model}`}
                                        className="p-1.5 text-[#9CA3AF] hover:text-red-500 hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-red-400 dark:hover:bg-[#27272a] rounded transition-colors"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {!modelsLoading &&
                        !modelsError &&
                        Object.keys(groupedModels).length === 0 && (
                          <div className="text-center py-8 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                            No models configured yet
                          </div>
                        )}
                    </div>
                  </div>

                  <button
                    data-add-model-trigger
                    onClick={() => {
                      setModelActionError(null);
                      setAddModelOpen(true);
                    }}
                    disabled={modelAction !== null}
                    className="w-full py-3 rounded-md text-[#6B7280] dark:text-[#a1a1aa] text-[13px] font-mono hover:bg-[#F3F4F6] dark:bg-[#18181b] transition-colors shrink-0"
                  >
                    + Add New Model
                  </button>
                </div>
              )}

              {activeTab === 'general' && (
                <div
                  id="settings-panel-general"
                  role="tabpanel"
                  aria-labelledby="settings-tab-general"
                  aria-busy={settings.isLoading}
                  className="flex flex-col gap-6 overflow-x-hidden overflow-y-auto pr-2 [&>div>div.flex]:flex-wrap [&>div>div.flex]:gap-2 [&_select]:max-w-full"
                >
                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">
                      General
                    </h3>
                    <div className="flex items-center justify-between py-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                          Response Language
                        </span>
                        <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] font-mono">
                          AI will respond in this language
                        </span>
                      </div>
                      <Select
                        aria-label="Response language"
                        value={settings.language}
                        onChange={(val) => settings.updateSettings({ language: val })}
                        className="h-8 w-auto min-w-[140px] text-[12px]"
                        options={[
                          { value: 'en-US', label: 'English (US)' },
                          { value: 'zh-CN', label: '简体中文' },
                          { value: 'zh-TW', label: '繁體中文' },
                          { value: 'ja-JP', label: '日本語' },
                          { value: 'ko-KR', label: '한국어' },
                          { value: 'es-ES', label: 'Español' },
                          { value: 'fr-FR', label: 'Français' },
                          { value: 'de-DE', label: 'Deutsch' },
                          { value: 'pt-BR', label: 'Português (BR)' },
                          { value: 'ru-RU', label: 'Русский' },
                        ]}
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Auto-save sessions
                      </span>
                      <ToggleSwitch
                        label="Auto-save sessions"
                        enabled={settings.autoSaveSessions}
                        onChange={(v) =>
                          settings.updateSettings({ autoSaveSessions: v })
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                          Communication Style
                        </span>
                        <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] font-mono">
                          How the agent phrases its replies across every session
                        </span>
                      </div>
                      <Select
                        aria-label="Communication style"
                        value={settings.communicationStyle ?? 'auto'}
                        onChange={(val) =>
                          settings.updateSettings({
                            communicationStyle: val,
                          })
                        }
                        className="h-8 w-auto min-w-[140px] text-[12px]"
                        options={DEFAULT_COMMUNICATION_STYLES.map((style) => ({
                          value: style.id,
                          label: style.name,
                        }))}
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">
                      Appearance
                    </h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Theme Preference
                      </span>
                      <div className="flex items-center gap-2 bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-1">
                        {(['dark', 'light', 'system'] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => settings.updateSettings({ uiTheme: mode })}
                            className={cn(
                              'px-3 py-1 rounded text-[12px] font-mono transition-colors',
                              settings.uiTheme === mode
                                ? 'bg-[#E5E7EB] dark:bg-[#27272a] text-[#111827] dark:text-[#E5E5E5]'
                                : 'text-[#9CA3AF] dark:text-[#71717a] hover:text-[#111827] dark:hover:text-[#E5E5E5]'
                            )}
                          >
                            {mode === 'dark'
                              ? 'Dark'
                              : mode === 'light'
                                ? 'Light'
                                : 'System'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Compact sidebar
                      </span>
                      <ToggleSwitch
                        label="Compact sidebar"
                        enabled={!isSidebarOpen}
                        onChange={(value) => setSidebarOpen(!value)}
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                          Code theme
                        </span>
                        <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] font-mono">
                          Syntax highlighting colors
                        </span>
                      </div>
                      <Select
                        aria-label="Code theme"
                        value={settings.theme}
                        onChange={(val) => settings.updateSettings({ theme: val })}
                        className="h-8 w-auto min-w-[140px] text-[12px]"
                        options={[
                          { value: 'dracula', label: 'Dracula' },
                          { value: 'monokai', label: 'Monokai' },
                          { value: 'nord', label: 'Nord' },
                          { value: 'tokyo-night', label: 'Tokyo Night' },
                          { value: 'one-dark', label: 'One Dark' },
                          { value: 'catppuccin', label: 'Catppuccin' },
                          { value: 'gruvbox', label: 'Gruvbox' },
                          { value: 'github', label: 'GitHub' },
                          { value: 'solarized-light', label: 'Solarized Light' },
                          { value: 'solarized-dark', label: 'Solarized Dark' },
                          { value: 'ayu-dark', label: 'Ayu Dark' },
                          { value: 'rose-pine', label: 'Rose Pine' },
                          { value: 'kanagawa', label: 'Kanagawa' },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">
                      Notifications
                    </h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Build finished
                      </span>
                      <ToggleSwitch
                        label="Build finished notifications"
                        enabled={settings.notifyBuild}
                        onChange={(v) => settings.updateSettings({ notifyBuild: v })}
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Errors only
                      </span>
                      <ToggleSwitch
                        label="Error notifications"
                        enabled={settings.notifyErrors}
                        onChange={(v) => settings.updateSettings({ notifyErrors: v })}
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        System sounds
                      </span>
                      <ToggleSwitch
                        label="System sounds"
                        enabled={settings.notifySounds}
                        onChange={(v) => settings.updateSettings({ notifySounds: v })}
                      />
                    </div>
                    {(settings.notifyBuild || settings.notifyErrors) &&
                      notificationPermission !== 'granted' && (
                        <div className="flex items-center justify-between gap-4 rounded-md border border-[#E5E7EB] bg-[#F9FAFB] px-3 py-2 dark:border-[#27272a] dark:bg-[#18181b]">
                          <span className="text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                            {notificationPermission === 'denied'
                              ? 'Browser notifications are blocked'
                              : notificationPermission === 'unsupported'
                                ? 'Browser notifications are unavailable'
                                : 'Enable alerts while this tab is in the background'}
                          </span>
                          {notificationPermission === 'default' && (
                            <button
                              type="button"
                              onClick={() => void requestNotificationPermission()}
                              className="shrink-0 rounded-md bg-[#111827] px-2.5 py-1.5 text-[10px] font-mono text-white hover:bg-[#374151] dark:bg-[#E5E5E5] dark:text-[#111827]"
                            >
                              Enable
                            </button>
                          )}
                        </div>
                      )}
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">
                      Privacy
                    </h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Telemetry
                      </span>
                      <ToggleSwitch
                        label="Telemetry"
                        enabled={settings.privacyTelemetry}
                        onChange={(v) =>
                          settings.updateSettings({ privacyTelemetry: v })
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                        Crash reports
                      </span>
                      <ToggleSwitch
                        label="Crash reports"
                        enabled={settings.privacyCrash}
                        onChange={(v) => settings.updateSettings({ privacyCrash: v })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'shortcuts' && (
                <div
                  id="settings-panel-shortcuts"
                  role="tabpanel"
                  aria-labelledby="settings-tab-shortcuts"
                  className="flex flex-col gap-4 flex-1 min-h-0 overflow-hidden"
                >
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <input
                      aria-label="Search shortcut actions"
                      value={shortcutQuery}
                      onChange={(event) => setShortcutQuery(event.target.value)}
                      placeholder="Search actions..."
                      className="field flex-1 text-[12px]"
                    />
                    <Select
                      aria-label="Shortcut scope"
                      value={shortcutScope}
                      onChange={(val) => setShortcutScope(val as typeof shortcutScope)}
                      className="w-auto min-w-[120px] text-[12px]"
                      options={[
                        { value: 'all', label: 'All scopes' },
                        { value: 'global', label: 'Global' },
                        { value: 'chat', label: 'Chat' },
                        { value: 'layout', label: 'Layout' },
                      ]}
                    />
                    <button
                      onClick={() => {
                        setShortcutQuery('');
                        setShortcutScope('all');
                      }}
                      className="h-9 px-3 rounded-md bg-[#E5E7EB] dark:bg-[#27272a] text-[#111827] dark:text-[#E5E5E5] text-[12px] font-mono font-semibold"
                    >
                      Reset
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-auto border border-[#E5E7EB] dark:border-[#27272a] rounded-lg bg-[#E5E7EB] dark:bg-[#111827]">
                    <div className="grid min-w-[520px] grid-cols-[1fr_180px_120px] gap-2 px-3 py-2 bg-white dark:bg-[#0C0C0C] text-[12px] text-[#6B7280] dark:text-[#94a3b8] font-mono font-semibold">
                      <span>Action</span>
                      <span>Shortcut</span>
                      <span>Scope</span>
                    </div>
                    {filteredShortcuts.map((shortcut, index) => (
                      <div
                        key={`${shortcut.action}-${shortcut.scope}`}
                        className={cn(
                          'grid min-w-[520px] grid-cols-[1fr_180px_120px] gap-2 px-3 py-2 text-[13px] font-mono',
                          index % 2 === 0
                            ? 'bg-[#E5E7EB] dark:bg-[#111827]'
                            : 'bg-white dark:bg-[#0C0C0C]'
                        )}
                      >
                        <span className="text-[#111827] dark:text-[#E5E5E5]">
                          {shortcut.action}
                        </span>
                        <div className="flex items-center gap-1">
                          {shortcut.combo.map((key) => (
                            <span
                              key={key}
                              className="px-2 py-0.5 rounded bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[12px] font-mono font-semibold"
                            >
                              {key}
                            </span>
                          ))}
                        </div>
                        <span className="text-[#6B7280] dark:text-[#94a3b8] text-[12px]">
                          {shortcut.scope}
                        </span>
                      </div>
                    ))}
                    {filteredShortcuts.length === 0 && (
                      <div className="px-3 py-6 text-center text-[12px] text-[#6B7280] dark:text-[#94a3b8] font-mono">
                        No shortcuts found.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'mcp' && (
                <div
                  id="settings-panel-mcp"
                  role="tabpanel"
                  aria-labelledby="settings-tab-mcp"
                  className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa]"
                >
                  <p>MCP server configuration is available via the MCP panel.</p>
                  <button
                    type="button"
                    onClick={() => {
                      useAppStore.getState().toggleMcp();
                    }}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-[#E5E7EB] px-3 text-[12px] font-medium text-[#111827] transition-colors hover:bg-[#F3F4F6] dark:border-zinc-700 dark:text-[#E5E5E5] dark:hover:bg-[#27272a]"
                  >
                    Open MCP Panel
                  </button>
                </div>
              )}

              {activeTab === 'skills' && (
                <div
                  id="settings-panel-skills"
                  role="tabpanel"
                  aria-labelledby="settings-tab-skills"
                  className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa]"
                >
                  <p>Skills configuration is available via the Skills panel.</p>
                  <button
                    type="button"
                    onClick={() => {
                      useAppStore.getState().toggleSkills();
                    }}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-[#E5E7EB] px-3 text-[12px] font-medium text-[#111827] transition-colors hover:bg-[#F3F4F6] dark:border-zinc-700 dark:text-[#E5E5E5] dark:hover:bg-[#27272a]"
                  >
                    Open Skills Panel
                  </button>
                </div>
              )}

              {activeTab === 'hooks' && (
                <div
                  id="settings-panel-hooks"
                  role="tabpanel"
                  aria-labelledby="settings-tab-hooks"
                  className="min-h-0 flex-1"
                >
                  <HookTrustPanel />
                </div>
              )}

              {activeTab === 'plugins' && (
                <div
                  id="settings-panel-plugins"
                  role="tabpanel"
                  aria-labelledby="settings-tab-plugins"
                  className="min-h-0 flex-1"
                >
                  <PluginPanel />
                </div>
              )}

              {activeTab === 'trust' && (
                <div
                  id="settings-panel-trust"
                  role="tabpanel"
                  aria-labelledby="settings-tab-trust"
                  className="min-h-0 flex-1"
                >
                  <WorkspaceTrustPanel />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {addModelOpen && (
        <AddModelModal
          open
          onOpenChange={(open) => {
            if (!open) nestedModalClosedAtRef.current = Date.now();
            setAddModelOpen(open);
          }}
          onSave={handleSaveModel}
          saveError={modelActionError}
        />
      )}

      {editingModel && (
        <EditModelModal
          open
          onOpenChange={(open) => {
            if (!open) {
              nestedModalClosedAtRef.current = Date.now();
              setEditingModel(null);
            }
          }}
          model={editingModel}
          onSave={handleUpdateModel}
          saveError={modelActionError}
        />
      )}

      {editingProvider && (
        <EditProviderModal
          provider={editingProvider}
          onOpenChange={(open) => {
            if (!open) {
              nestedModalClosedAtRef.current = Date.now();
              setEditingProvider(null);
            }
          }}
          onSave={handleUpdateProvider}
          saveError={providerActionError}
        />
      )}
    </>
  );
}

function ToggleSwitch({
  label,
  enabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        'flex h-6 w-11 items-center rounded-full px-1 transition-colors',
        enabled ? 'bg-[#22C55E]' : 'bg-[#E5E7EB] dark:bg-[#27272a]'
      )}
    >
      <span
        className={cn(
          'h-4 w-4 rounded-full transition-transform',
          enabled
            ? 'translate-x-5 bg-white'
            : 'translate-x-0 bg-white dark:bg-[#a1a1aa]'
        )}
      />
    </button>
  );
}
