import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/store/AppStore"
import { useConfigStore, type ModelConfig } from "@/store/ConfigStore"
import { useSettingsStore } from "@/store/SettingsStore"
import { ChevronDown, Pencil, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { AddModelModal, type ModelFormData } from "./AddModelModal"
import { EditModelModal } from "./EditModelModal"

type TabValue = 'general' | 'models' | 'shortcuts'

const PROVIDER_ICONS: Record<string, { bg: string; label: string }> = {
  'openai-compatible': { bg: '#10a37f', label: 'OA' },
  'anthropic': { bg: '#d97757', label: 'A' },
  'gemini': { bg: '#4285f4', label: 'G' },
  'azure-openai': { bg: '#0078d4', label: 'Az' },
  'copilot': { bg: '#6e40c9', label: 'CP' },
  'gpt-openai-platform': { bg: '#10a37f', label: 'GP' },
  'antigravity': { bg: '#8b5cf6', label: 'AG' },
}

export function SettingsModal() {
  const { isSettingsOpen, toggleSettings, isSidebarOpen, setSidebarOpen } = useAppStore()
  const { configuredModels, loadModels } = useConfigStore()
  const settings = useSettingsStore()
  const [activeTab, setActiveTab] = useState<TabValue>('general')
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutScope, setShortcutScope] = useState<'all' | 'global' | 'chat' | 'layout' | 'history'>('all')

  const tabs: { value: TabValue; label: string }[] = [
    { value: 'general', label: 'General' },
    { value: 'models', label: 'Models' },
    { value: 'shortcuts', label: 'Shortcuts' },
  ]

  const shortcuts = useMemo(() => ([
    { action: 'Open command palette', combo: ['Ctrl', 'K'], scope: 'Global' },
    { action: 'New chat', combo: ['Ctrl', 'N'], scope: 'Chat' },
    { action: 'Focus input', combo: ['Ctrl', 'L'], scope: 'Chat' },
    { action: 'Toggle sidebar', combo: ['Ctrl', 'B'], scope: 'Layout' },
    { action: 'Search history', combo: ['Ctrl', 'H'], scope: 'History' },
  ]), [])

  const filteredShortcuts = shortcuts.filter((shortcut) => {
    const matchesQuery = shortcut.action.toLowerCase().includes(shortcutQuery.toLowerCase())
    const matchesScope = shortcutScope === 'all' || shortcut.scope.toLowerCase() === shortcutScope
    return matchesQuery && matchesScope
  })

  const groupedModels = configuredModels.reduce((acc, model) => {
    const provider = model.provider || 'unknown'
    if (!acc[provider]) {
      acc[provider] = []
    }
    acc[provider].push(model)
    return acc
  }, {} as Record<string, typeof configuredModels>)

  useEffect(() => {
    if (isSettingsOpen) {
      loadModels()
      settings.loadSettings()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsOpen, loadModels, settings.loadSettings])

  const handleSaveModel = async (formData: ModelFormData) => {
    try {
      const response = await fetch('/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: formData.bladeProvider,
          name: formData.name || formData.modelId,
          model: formData.modelId,
          baseUrl: formData.baseUrl || undefined,
          apiKey: formData.apiKey || undefined,
        }),
      })
      if (!response.ok) throw new Error('Failed to save model')
      await loadModels()
    } catch (err) {
      console.error('Failed to save model:', err)
    }
  }

  const handleDeleteModel = async (modelId: string) => {
    try {
      const response = await fetch(`/models/${modelId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Failed to delete model')
      await loadModels()
    } catch (err) {
      console.error('Failed to delete model:', err)
    }
  }

  const handleUpdateModel = async (modelId: string, updates: Partial<ModelConfig>) => {
    try {
      const response = await fetch(`/models/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error('Failed to update model')
      await loadModels()
    } catch (err) {
      console.error('Failed to update model:', err)
    }
  }

  const toggleProvider = (provider: string) => {
    setExpandedProvider(expandedProvider === provider ? null : provider)
  }

  return (
    <>
      <Dialog open={isSettingsOpen} onOpenChange={toggleSettings}>
        <DialogContent className="sm:max-w-[800px] h-[600px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl flex flex-col" aria-describedby={undefined} hideCloseButton>
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <div className="flex h-full">
            <div className="w-[200px] h-full bg-[#F3F4F6] dark:bg-[#18181b] p-6 flex flex-col gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md text-sm font-mono transition-colors",
                    activeTab === tab.value
                      ? "bg-[#E5E7EB] dark:bg-[#27272a] text-[#111827] dark:text-[#E5E5E5] font-medium"
                      : "text-[#6B7280] hover:text-[#111827] hover:bg-[#E5E7EB]/60 dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a]/50"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 p-8 flex flex-col gap-6 overflow-hidden">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
                  {activeTab === 'general' ? 'Settings' : tabs.find((tab) => tab.value === activeTab)?.label}
                </h2>
                <button
                  onClick={toggleSettings}
                  className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {activeTab === 'models' && (
                <div className="flex flex-col gap-6 flex-1 min-h-0 overflow-hidden">
                  <p className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono shrink-0">
                    Configure API keys and model settings for different providers.
                  </p>

                  <div className="flex-1 overflow-y-auto min-h-0">
                  <div className="flex flex-col gap-2 pr-2">
                    {Object.entries(groupedModels).map(([provider, models]) => {
                      const iconInfo = PROVIDER_ICONS[provider] || { bg: '#71717a', label: '?' }
                      const isConnected = models.some(m => m.apiKey)
                      const isExpanded = expandedProvider === provider

                      return (
                        <div key={provider} className="w-full bg-[#F3F4F6] dark:bg-[#18181b] rounded-lg overflow-hidden">
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
                              <span className={cn(
                                "text-xs font-mono",
                                isConnected ? "text-[#16A34A]" : "text-[#9CA3AF] dark:text-[#71717a]"
                              )}>
                                {isConnected ? "● Connected" : "○ Not Connected"}
                              </span>
                              <ChevronDown className={cn(
                                "h-4 w-4 text-[#9CA3AF] dark:text-[#71717a] transition-transform",
                                isExpanded && "rotate-180"
                              )} />
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
                                      {model.model}
                                    </span>
                                    <span className="text-xs text-[#9CA3AF] dark:text-[#71717a] font-mono truncate">
                                      {model.baseUrl || 'Default URL'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                      onClick={() => setEditingModel(model)}
                                      className="p-1.5 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] rounded transition-colors"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteModel(model.id)}
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
                      )
                    })}

                    {Object.keys(groupedModels).length === 0 && (
                      <div className="text-center py-8 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                        No models configured yet
                      </div>
                    )}
                  </div>
                  </div>

                  <button 
                    onClick={() => setAddModelOpen(true)}
                    className="w-full py-3 rounded-md text-[#6B7280] dark:text-[#a1a1aa] text-[13px] font-mono hover:bg-[#F3F4F6] dark:bg-[#18181b] transition-colors shrink-0"
                  >
                    + Add New Model
                  </button>
                </div>
              )}

              {activeTab === 'general' && (
                <div className="flex flex-col gap-6 overflow-y-auto pr-2">
                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">General</h3>
                    <div className="flex items-center justify-between py-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Response Language</span>
                        <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] font-mono">AI will respond in this language</span>
                      </div>
                      <select
                        value={settings.language}
                        onChange={(e) => settings.updateSettings({ language: e.target.value })}
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
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Auto-save sessions</span>
                      <ToggleSwitch 
                        enabled={settings.autoSaveSessions} 
                        onChange={(v) => settings.updateSettings({ autoSaveSessions: v })} 
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">Appearance</h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Theme Preference</span>
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
                            {mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'System'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Compact sidebar</span>
                      <ToggleSwitch enabled={!isSidebarOpen} onChange={(value) => setSidebarOpen(!value)} />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Code theme</span>
                        <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] font-mono">Syntax highlighting colors</span>
                      </div>
                      <select
                        value={settings.theme}
                        onChange={(e) => settings.updateSettings({ theme: e.target.value })}
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
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">Notifications</h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Build finished</span>
                      <ToggleSwitch 
                        enabled={settings.notifyBuild} 
                        onChange={(v) => settings.updateSettings({ notifyBuild: v })} 
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Errors only</span>
                      <ToggleSwitch 
                        enabled={settings.notifyErrors} 
                        onChange={(v) => settings.updateSettings({ notifyErrors: v })} 
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">System sounds</span>
                      <ToggleSwitch 
                        enabled={settings.notifySounds} 
                        onChange={(v) => settings.updateSettings({ notifySounds: v })} 
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono font-semibold">Privacy</h3>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Telemetry</span>
                      <ToggleSwitch 
                        enabled={settings.privacyTelemetry} 
                        onChange={(v) => settings.updateSettings({ privacyTelemetry: v })} 
                      />
                    </div>
                    <div className="flex items-center justify-between py-2">
                      <span className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Crash reports</span>
                      <ToggleSwitch 
                        enabled={settings.privacyCrash} 
                        onChange={(v) => settings.updateSettings({ privacyCrash: v })} 
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'shortcuts' && (
                <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
                  <div className="flex items-center gap-3 shrink-0">
                    <input
                      value={shortcutQuery}
                      onChange={(event) => setShortcutQuery(event.target.value)}
                      placeholder="Search actions..."
                      className="flex-1 h-9 bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono"
                    />
                    <select
                      value={shortcutScope}
                      onChange={(event) => setShortcutScope(event.target.value as typeof shortcutScope)}
                      className="h-9 bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono"
                    >
                      <option value="all">All scopes</option>
                      <option value="global">Global</option>
                      <option value="chat">Chat</option>
                      <option value="layout">Layout</option>
                      <option value="history">History</option>
                    </select>
                    <button
                      onClick={() => {
                        setShortcutQuery('')
                        setShortcutScope('all')
                      }}
                      className="h-9 px-3 rounded-md bg-[#E5E7EB] dark:bg-[#27272a] text-[#111827] dark:text-[#E5E5E5] text-[12px] font-mono font-semibold"
                    >
                      Reset
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto border border-[#E5E7EB] dark:border-[#27272a] rounded-lg bg-[#E5E7EB] dark:bg-[#111827]">
                    <div className="grid grid-cols-[1fr_180px_120px] gap-2 px-3 py-2 bg-white dark:bg-[#0C0C0C] text-[12px] text-[#6B7280] dark:text-[#94a3b8] font-mono font-semibold">
                      <span>Action</span>
                      <span>Shortcut</span>
                      <span>Scope</span>
                    </div>
                    {filteredShortcuts.map((shortcut, index) => (
                      <div
                        key={`${shortcut.action}-${shortcut.scope}`}
                        className={cn(
                          'grid grid-cols-[1fr_180px_120px] gap-2 px-3 py-2 text-[13px] font-mono',
                          index % 2 === 0 ? 'bg-[#E5E7EB] dark:bg-[#111827]' : 'bg-white dark:bg-[#0C0C0C]'
                        )}
                      >
                        <span className="text-[#111827] dark:text-[#E5E5E5]">{shortcut.action}</span>
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
                        <span className="text-[#6B7280] dark:text-[#94a3b8] text-[12px]">{shortcut.scope}</span>
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
      />

      <EditModelModal
        open={!!editingModel}
        onOpenChange={(open) => !open && setEditingModel(null)}
        model={editingModel}
        onSave={handleUpdateModel}
      />
    </>
  )
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={cn(
        'w-10 h-5 rounded-full px-0.5 flex items-center transition-colors',
        enabled ? 'bg-[#22C55E]' : 'bg-[#E5E7EB] dark:bg-[#27272a]'
      )}
    >
      <span
        className={cn(
          'h-4 w-4 rounded-full transition-transform',
          enabled ? 'translate-x-5 bg-white' : 'translate-x-0 bg-white dark:bg-[#a1a1aa]'
        )}
      />
    </button>
  )
}
