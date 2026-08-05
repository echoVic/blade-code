import { ChevronDown, Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface AddModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (model: ModelFormData) => void;
}

export interface ModelFormData {
  provider: string;
  model: string;
  displayName: string;
  apiKey?: string;
}

interface ProviderOption {
  id: string;
  name: string;
  modelCount: number;
  supportsApiKey: boolean;
  configured: boolean;
}

interface ModelOption {
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  input: string[];
}

export function AddModelModal({ open, onOpenChange, onSave }: AddModelModalProps) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [provider, setProvider] = useState<ProviderOption>();
  const [model, setModel] = useState<ModelOption>();
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (!open) return;
    setModels([]);
    setProvider(undefined);
    setModel(undefined);
    setDisplayName('');
    setApiKey('');
    setProviderOpen(false);
    setModelOpen(false);
    setShowApiKey(false);
    void fetch('/providers')
      .then((response) => response.json())
      .then(setProviders);
  }, [open]);

  useEffect(() => {
    if (!provider) return;
    void fetch(`/providers/${provider.id}/models`)
      .then((response) => response.json())
      .then(setModels);
  }, [provider]);

  const submit = () => {
    if (!provider || !model || (!provider.configured && !apiKey)) {
      return;
    }
    onSave({
      provider: provider.id,
      model: model.id,
      displayName: displayName || model.name,
      apiKey: apiKey || undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl [&>button]:hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Add Model</DialogTitle>
        <div className="flex flex-col gap-6 p-6">
          <div className="flex justify-between items-center">
            <h2 className="font-mono text-base font-semibold">Add Model</h2>
            <button type="button" onClick={() => onOpenChange(false)}>
              <X className="w-4 h-4" />
            </button>
          </div>

          <SelectField
            label="Provider"
            value={provider?.name ?? 'Select provider'}
            open={providerOpen}
            setOpen={setProviderOpen}
            options={providers.map((entry) => ({
              id: entry.id,
              label: `${entry.name} (${entry.modelCount})${entry.configured ? ' · configured' : ''}`,
              selected: provider?.id === entry.id,
              select: () => {
                setProvider(entry);
                setModel(undefined);
                setProviderOpen(false);
              },
            }))}
          />

          <SelectField
            label="Model"
            value={model?.name ?? 'Select model'}
            open={modelOpen}
            setOpen={setModelOpen}
            options={models.map((entry) => ({
              id: entry.id,
              label: `${entry.name} · ${Math.round(entry.contextWindow / 1000)}K${entry.reasoning ? ' · reasoning' : ''}${entry.input.includes('image') ? ' · vision' : ''}`,
              selected: model?.id === entry.id,
              select: () => {
                setModel(entry);
                setDisplayName(entry.name);
                setModelOpen(false);
              },
            }))}
          />

          <TextField
            label="Display name"
            value={displayName}
            onChange={setDisplayName}
            placeholder={model?.name ?? 'Optional alias'}
          />

          {provider?.supportsApiKey && !provider.configured && (
            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-zinc-500 font-mono">API Key</label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="pr-10 field"
                  placeholder="Stored separately in auth.json"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                >
                  {showApiKey ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {provider && !provider.configured && !provider.supportsApiKey && (
            <p className="font-mono text-sm text-amber-600">
              This provider requires OAuth or ambient credentials. Configure it
              externally before selecting the model.
            </p>
          )}

          <button
            type="button"
            disabled={
              !provider ||
              !model ||
              (!provider.configured &&
                (!provider.supportsApiKey || apiKey.trim().length === 0))
            }
            onClick={submit}
            className="px-4 py-2 font-mono text-sm font-semibold text-white bg-green-600 rounded-md disabled:opacity-50"
          >
            Save Model
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface SelectOption {
  id: string;
  label: string;
  selected: boolean;
  select: () => void;
}

function SelectField(props: {
  label: string;
  value: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  options: SelectOption[];
}) {
  return (
    <div className="flex relative flex-col gap-2">
      <label className="text-[13px] text-zinc-500 font-mono">{props.label}</label>
      <button
        type="button"
        onClick={() => props.setOpen(!props.open)}
        className="flex justify-between field"
      >
        {props.value}
        <ChevronDown className="w-4 h-4" />
      </button>
      {props.open && (
        <div className="overflow-y-auto absolute right-0 left-0 top-full z-50 max-h-64 bg-white rounded-md border dark:bg-zinc-900">
          {props.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={option.select}
              className={cn(
                'w-full text-left px-3 py-2 text-sm font-mono',
                option.selected && 'bg-zinc-100 dark:bg-zinc-800'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] text-zinc-500 font-mono">{props.label}</label>
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="field"
      />
    </div>
  );
}
