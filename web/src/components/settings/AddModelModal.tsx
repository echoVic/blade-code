import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChevronDown, Eye, EyeOff, X } from "lucide-react"
import { useEffect, useState } from "react"

interface AddModelModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (model: ModelFormData) => void
}

export interface ModelFormData {
  bladeProvider: string
  baseUrl: string
  apiKey: string
  modelId: string
  name: string
}

interface ProviderOption {
  id: string
  name: string
  icon: string
  description: string
  isOAuth: boolean
  envVars: string[]
  defaultBaseUrl?: string
  bladeProvider: string
}

interface ModelOption {
  id: string
  name: string
  contextWindow?: number
}

const CUSTOM_PROVIDER: ProviderOption = {
  id: 'custom',
  name: 'Custom (OpenAI Compatible)',
  icon: '🔌',
  description: 'Any OpenAI-compatible API',
  isOAuth: false,
  envVars: [],
  bladeProvider: 'openai-compatible',
}

export function AddModelModal({ open, onOpenChange, onSave }: AddModelModalProps) {
  const [providers, setProviders] = useState<ProviderOption[]>([CUSTOM_PROVIDER])
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('custom')
  const [formData, setFormData] = useState<ModelFormData>({
    bladeProvider: 'openai-compatible',
    baseUrl: '',
    apiKey: '',
    modelId: '',
    name: '',
  })
  const [providerOpen, setProviderOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (open) {
      fetch('/providers')
        .then(res => res.json())
        .then(data => setProviders([CUSTOM_PROVIDER, ...data]))
        .catch(err => console.error('Failed to load providers:', err))
    }
  }, [open])

  useEffect(() => {
    if (selectedProviderId && selectedProviderId !== 'custom') {
      fetch(`/providers/${selectedProviderId}/models`)
        .then(res => res.json())
        .then(data => setModels(data))
        .catch(err => console.error('Failed to load models:', err))
    } else {
      setModels([])
    }
  }, [selectedProviderId])

  const handleProviderSelect = (provider: ProviderOption) => {
    setSelectedProviderId(provider.id)
    setFormData({
      ...formData,
      bladeProvider: provider.bladeProvider,
      baseUrl: provider.defaultBaseUrl || '',
      modelId: '',
      name: '',
    })
    setProviderOpen(false)
  }

  const handleSubmit = () => {
    if (!formData.modelId || !formData.apiKey) return
    onSave({
      ...formData,
      name: formData.name || formData.modelId,
    })
    setFormData({
      bladeProvider: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      modelId: '',
      name: '',
    })
    setSelectedProviderId('custom')
    onOpenChange(false)
  }

  const selectedProvider = providers.find(p => p.id === selectedProviderId)
  const selectedModel = models.find(m => m.id === formData.modelId)
  const isCustom = selectedProviderId === 'custom'
  const canSubmit = formData.modelId && formData.apiKey

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl [&>button]:hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Add Model</DialogTitle>
        <div className="p-6 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
              Add Model
            </h2>
            <button
              onClick={() => onOpenChange(false)}
              className="text-[#9CA3AF] hover:text-[#111827] dark:text-[#71717a] dark:hover:text-[#E5E5E5] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Provider</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProviderOpen(!providerOpen)}
                  className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono flex items-center justify-between hover:bg-[#E5E7EB] dark:hover:bg-[#27272a] transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span>{selectedProvider?.icon}</span>
                    <span>{selectedProvider?.name}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
                </button>
                {providerOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setProviderOpen(false)} />
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-zinc-800 rounded-md py-1 z-50 max-h-64 overflow-y-auto shadow-lg">
                      {providers.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          className={cn(
                            "w-full text-left px-3 py-2 text-sm font-mono hover:bg-[#F3F4F6] dark:hover:bg-[#27272a] transition-colors",
                            selectedProviderId === provider.id
                              ? "text-[#111827] dark:text-[#E5E5E5] bg-[#F3F4F6] dark:bg-[#27272a]"
                              : "text-[#6B7280] dark:text-[#a1a1aa]"
                          )}
                          onClick={() => handleProviderSelect(provider)}
                        >
                          <div className="flex items-center gap-2">
                            <span>{provider.icon}</span>
                            <span className="font-medium">{provider.name}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Base URL</label>
              <input
                type="text"
                value={formData.baseUrl}
                onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                placeholder={selectedProvider?.defaultBaseUrl || "https://api.openai.com/v1"}
                className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB] dark:focus:ring-zinc-600"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">API Key</label>
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="sk-........................"
                  className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 pr-10 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB] dark:focus:ring-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#111827] dark:text-[#71717a] dark:hover:text-[#E5E5E5] transition-colors"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Model ID</label>
              {!isCustom && models.length > 0 ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModelOpen(!modelOpen)}
                    className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono flex items-center justify-between hover:bg-[#E5E7EB] dark:hover:bg-[#27272a] transition-colors"
                  >
                    {selectedModel?.name || formData.modelId || 'Select model'}
                    <ChevronDown className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
                  </button>
                  {modelOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setModelOpen(false)} />
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-zinc-800 rounded-md py-1 z-50 max-h-48 overflow-y-auto shadow-lg">
                        {models.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            className={cn(
                              "w-full text-left px-3 py-2 text-sm font-mono hover:bg-[#F3F4F6] dark:hover:bg-[#27272a] transition-colors",
                              formData.modelId === model.id
                                ? "text-[#111827] dark:text-[#E5E5E5] bg-[#F3F4F6] dark:bg-[#27272a]"
                                : "text-[#6B7280] dark:text-[#a1a1aa]"
                            )}
                            onClick={() => {
                              setFormData({ ...formData, modelId: model.id, name: model.name })
                              setModelOpen(false)
                            }}
                          >
                            {model.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={formData.modelId}
                  onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                  placeholder="gpt-4o, claude-3-opus, deepseek-chat, etc."
                  className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB] dark:focus:ring-zinc-600"
                />
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex-1 px-4 py-2 rounded-md text-sm text-[#6B7280] dark:text-[#a1a1aa] font-mono hover:bg-[#F3F4F6] dark:hover:bg-[#18181b] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex-1 px-4 py-2 rounded-md text-sm text-white font-semibold font-mono bg-[#16A34A] hover:bg-[#15803d] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Save Model
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
