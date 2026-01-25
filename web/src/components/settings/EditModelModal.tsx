import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ModelConfig } from "@/store/ConfigStore"
import { Eye, EyeOff, X } from "lucide-react"
import { useEffect, useState } from "react"

interface EditModelModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  model: ModelConfig | null
  onSave: (modelId: string, updates: Partial<ModelConfig>) => void
}

export function EditModelModal({ open, onOpenChange, model, onSave }: EditModelModalProps) {
  const [formData, setFormData] = useState({
    baseUrl: '',
    apiKey: '',
    model: '',
  })
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (model) {
      setFormData({
        baseUrl: model.baseUrl || '',
        apiKey: model.apiKey || '',
        model: model.model || '',
      })
    }
  }, [model])

  const handleSubmit = () => {
    if (!model || !formData.model) return
    onSave(model.id, {
      baseUrl: formData.baseUrl || undefined,
      apiKey: formData.apiKey || undefined,
      model: formData.model,
    })
    onOpenChange(false)
  }

  const canSubmit = formData.model

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl [&>button]:hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Edit Model</DialogTitle>
        <div className="p-6 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
              Edit Model
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
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Model ID</label>
              <input
                type="text"
                value={formData.model}
                onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                placeholder="gpt-4o, claude-3-opus, etc."
                className="w-full bg-[#F3F4F6] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2.5 text-sm text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB] dark:focus:ring-zinc-600"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Base URL</label>
              <input
                type="text"
                value={formData.baseUrl}
                onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
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
                  placeholder="Leave empty to keep current key"
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
              Save Changes
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
