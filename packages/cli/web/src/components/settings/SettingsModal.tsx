import { AlertCircle, ChevronDown, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { requestJson } from '@/lib/http';
import {
  KEYBOARD_SHORTCUTS,
  type ShortcutId,
  shortcutKeyLabels,
} from '@/lib/keyboardShortcuts';
import {
  restoreFocusToSelector,
  restoreMobileNavigationFocus,
} from '@/lib/mobileNavigationFocus';
import { cn } from '@/lib/utils';
import { type SettingsSection, useAppStore } from '@/store/AppStore';
import { type ModelConfig, useConfigStore } from '@/store/ConfigStore';
import { useSettingsStore } from '@/store/SettingsStore';
import { AddModelModal, type ModelFormData } from './AddModelModal';
import { EditModelModal } from './EditModelModal';

type TabValue = SettingsSection;

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
  const [modelAction, setModelAction] = useState<'save' | 'update' | 'delete' | null>(
    null
  );
  const [modelActionError, setModelActionError] = useState<string | null>(null);
  const [shortcutQuery, setShortcutQuery] = useState('');
  const [shortcutScope, setShortcutScope] = useState<
    'all' | 'global' | 'chat' | 'layout'
  >('all');
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  const tabs: { value: TabValue; label: string }[] = [
    { value: 'general', label: 'General' },
    { value: 'models', label: 'Models' },
    { value: 'shortcuts', label: 'Shortcuts' },
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

  useEffect(() => {
    if (isSettingsOpen) {
      setActiveTab(settingsSection);
      loadModels();
      settings.loadSettings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsOpen, loadModels, settings.loadSettings, settingsSection]);

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
        }),
      });
      await loadModels();
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

  return (
    <>
      <Dialog open={isSettingsOpen} onOpenChange={toggleSettings}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (restoreFocusToSelector('[data-model-setup-trigger]', event)) return;
            restoreMobileNavigationFocus(event);
          }}
          className="flex h-[min(600px,calc(100dvh-24px))] flex-col gap-0 overflow-hidden rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[800px]"
          aria-describedby={undefined}
          hideCloseButton
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <div className="flex h-full min-h-0 flex-col sm:flex-row">
            <div
              role="tablist"
              aria-label="Settings sections"
              className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[#E5E7EB] bg-[#F3F4F6] p-2 dark:border-zinc-800 dark:bg-[#18181b] sm:h-full sm:w-[200px] sm:flex-col sm:gap-2 sm:border-b-0 sm:p-6"
            >
              {tabs.map((tab, index) => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  role="tab"
                  id={`settings-tab-${tab.value}`}
                  aria-controls={`settings-panel-${tab.value}`}
                  aria-selected={activeTab === tab.value}
                  tabIndex={activeTab === tab.value ? 0 : -1}
                  className={cn(
                    'shrink-0 rounded-md px-3 py-2 text-left font-mono text-sm transition-colors sm:w-full',
                    activeTab === tab.value
                      ? 'bg-[#E5E7EB] dark:bg-[#27272a] text-[#111827] dark:text-[#E5E5E5] font-medium'
                      : 'text-[#6B7280] hover:text-[#111827] hover:bg-[#E5E7EB]/60 dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a]/50'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:gap-6 sm:p-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
                  {activeTab === 'general'
                    ? 'Settings'
                    : tabs.find((tab) => tab.value === activeTab)?.label}
                </h2>
                <button
                  onClick={toggleSettings}
                  aria-label="Close settings"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#9CA3AF] transition-colors hover:bg-[#E5E7EB] hover:text-[#111827] dark:text-[#71717a] dark:hover:bg-[#27272a] dark:hover:text-[#E5E5E5]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

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

                  {(modelsError || modelActionError) && (
                    <div
                      role="alert"
                      className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                    >
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {modelActionError || modelsError}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setModelActionError(null);
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
                        const isExpanded = expandedProvider === provider;

                        return (
                          <div
                            key={provider}
                            className="w-full bg-[#F3F4F6] dark:bg-[#18181b] rounded-lg overflow-hidden"
                          >
                            <button
                              onClick={() => toggleProvider(provider)}
                              className="w-full p-4 flex items-center justify-between hover:bg-[#E5E7EB] dark:hover:bg-[#1f1f23] transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className="w-8 h-8 rounded flex items-center justify-center text-white text-xs font-bold"
                                  style={{ backgroundColor: iconInfo.bg }}
                                >
                                  {iconInfo.label}
                                </div>
                                <div className="flex flex-col gap-0.5 text-left">
                                  <span className="text-sm font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono capitalize">
                                    {provider.replace(/-/g, ' ')}
                                  </span>
                                  <span className="text-xs text-[#9CA3AF] dark:text-[#71717a] font-mono">
                                    {models.length} model{models.length > 1 ? 's' : ''}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-3">
                                <span className="text-xs font-mono text-[#16A34A]">
                                  ● Configured
                                </span>
                                <ChevronDown
                                  className={cn(
                                    'h-4 w-4 text-[#9CA3AF] dark:text-[#71717a] transition-transform',
                                    isExpanded && 'rotate-180'
                                  )}
                                />
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="border-t border-[#E5E7EB] dark:border-zinc-800">
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
                      <select
                        aria-label="Response language"
                        value={settings.language}
                        onChange={(e) =>
                          settings.updateSettings({ language: e.target.value })
                        }
                        className="h-8 bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[12px] font-mono rounded-md px-3 border border-[#E5E7EB] dark:border-[#27272a]"
                      >
                        <option value="en-US">English (US)</option>
                        <option value="zh-CN">简体中文</option>
                        <option value="zh-TW">繁體中文</option>
                        <option value="ja-JP">日本語</option>
                        <option value="ko-KR">한국어</option>
                        <option value="es-ES">Español</option>
                        <option value="fr-FR">Français</option>
                        <option value="de-DE">Deutsch</option>
                        <option value="pt-BR">Português (BR)</option>
                        <option value="ru-RU">Русский</option>
                      </select>
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
                      <select
                        aria-label="Code theme"
                        value={settings.theme}
                        onChange={(e) =>
                          settings.updateSettings({ theme: e.target.value })
                        }
                        className="h-8 bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[12px] font-mono rounded-md px-3 border border-[#E5E7EB] dark:border-[#27272a]"
                      >
                        <option value="dracula">Dracula</option>
                        <option value="monokai">Monokai</option>
                        <option value="nord">Nord</option>
                        <option value="tokyo-night">Tokyo Night</option>
                        <option value="one-dark">One Dark</option>
                        <option value="catppuccin">Catppuccin</option>
                        <option value="gruvbox">Gruvbox</option>
                        <option value="github">GitHub</option>
                        <option value="solarized-light">Solarized Light</option>
                        <option value="solarized-dark">Solarized Dark</option>
                        <option value="ayu-dark">Ayu Dark</option>
                        <option value="rose-pine">Rose Pine</option>
                        <option value="kanagawa">Kanagawa</option>
                      </select>
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
                      className="flex-1 h-9 bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono"
                    />
                    <select
                      aria-label="Shortcut scope"
                      value={shortcutScope}
                      onChange={(event) =>
                        setShortcutScope(event.target.value as typeof shortcutScope)
                      }
                      className="h-9 bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono"
                    >
                      <option value="all">All scopes</option>
                      <option value="global">Global</option>
                      <option value="chat">Chat</option>
                      <option value="layout">Layout</option>
                    </select>
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
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AddModelModal
        open={addModelOpen}
        onOpenChange={setAddModelOpen}
        onSave={handleSaveModel}
        saveError={modelActionError}
      />

      <EditModelModal
        open={!!editingModel}
        onOpenChange={(open) => !open && setEditingModel(null)}
        model={editingModel}
        onSave={handleUpdateModel}
        saveError={modelActionError}
      />
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
