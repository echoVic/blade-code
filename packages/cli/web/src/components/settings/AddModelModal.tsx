import { AlertCircle, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { requestJson } from '@/lib/http';
import { restoreFocusToSelector } from '@/lib/mobileNavigationFocus';

interface AddModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (model: ModelFormData) => Promise<boolean>;
  saveError: string | null;
}

export interface ModelFormData {
  provider: string;
  model: string;
  displayName: string;
  apiKey?: string;
  modelProvider?: {
    id: string;
    name: string;
    baseUrl: string;
    wireApi: 'openai-completions' | 'anthropic-messages';
  };
  overrides?: {
    baseUrl?: string;
  };
}

interface ProviderOption {
  id: string;
  name: string;
  modelCount: number;
  supportsApiKey: boolean;
  configured: boolean;
  custom: boolean;
  factoryWireApi?: 'openai-completions' | 'anthropic-messages';
  wireApi?: 'openai-completions' | 'anthropic-messages';
}

interface ModelOption {
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  input: string[];
}

const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function AddModelModal({
  open,
  onOpenChange,
  onSave,
  saveError,
}: AddModelModalProps) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [provider, setProvider] = useState<ProviderOption>();
  const [model, setModel] = useState<ModelOption>();
  const [displayName, setDisplayName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channelName, setChannelName] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setModels([]);
    setProvider(undefined);
    setModel(undefined);
    setDisplayName('');
    setChannelId('');
    setChannelName('');
    setCustomModelId('');
    setCustomBaseUrl('');
    setApiKey('');
    setShowApiKey(false);
    setLoadError(null);
    setLoadingProviders(true);
    void requestJson<ProviderOption[]>('/providers')
      .then((data) => {
        if (active) setProviders(data);
      })
      .catch((error) => {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load providers'
          );
        }
      })
      .finally(() => {
        if (active) setLoadingProviders(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setModels([]);
    setModel(undefined);
    setLoadError(null);
    if (provider.factoryWireApi || provider.custom) {
      setLoadingModels(false);
      return () => {
        active = false;
      };
    }
    setLoadingModels(true);
    void requestJson<ModelOption[]>(`/providers/${provider.id}/models`)
      .then((data) => {
        if (active) setModels(data);
      })
      .catch((error) => {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : 'Failed to load models'
          );
        }
      })
      .finally(() => {
        if (active) setLoadingModels(false);
      });
    return () => {
      active = false;
    };
  }, [provider]);

  const customFactory = provider?.factoryWireApi;
  const customProvider = Boolean(customFactory || provider?.custom);
  const selectedModelId = customProvider ? customModelId.trim() : model?.id;

  const submit = async () => {
    if (!provider || !selectedModelId || (!provider.configured && !apiKey)) {
      return;
    }
    if (customFactory) {
      if (!CHANNEL_ID_PATTERN.test(channelId.trim())) {
        setLoadError(
          'Channel ID must start with a lowercase letter and contain only lowercase letters, numbers, ".", "_" or "-"'
        );
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(customBaseUrl.trim());
      } catch {
        setLoadError('Base URL must be an absolute HTTP(S) URL');
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setLoadError('Base URL must be an absolute HTTP(S) URL');
        return;
      }
    }
    setSaving(true);
    const resolvedProvider = customFactory ? channelId.trim() : provider.id;
    const saved = await onSave({
      provider: resolvedProvider,
      model: selectedModelId,
      displayName:
        displayName || (customProvider ? selectedModelId : (model?.name ?? '')),
      apiKey: apiKey || undefined,
      ...(customFactory
        ? {
            modelProvider: {
              id: resolvedProvider,
              name: channelName.trim() || resolvedProvider,
              baseUrl: customBaseUrl.trim(),
              wireApi: customFactory,
            },
          }
        : {}),
    });
    setSaving(false);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) =>
          restoreFocusToSelector('[data-add-model-trigger]', event)
        }
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
        className="gap-0 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[480px]"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Add Model</DialogTitle>
        <div className="flex flex-col gap-5 p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-base font-semibold">Add Model</h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close add model"
              className="flex h-8 w-8 items-center justify-center rounded-md"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {(loadError || saveError) && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{loadError || saveError}</span>
            </div>
          )}

          <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
            Provider
            <Select
              aria-label="Provider"
              value={provider?.id ?? ''}
              disabled={loadingProviders}
              onChange={(val) => {
                setProvider(providers.find((entry) => entry.id === val));
                setDisplayName('');
                setChannelId('');
                setChannelName('');
                setCustomModelId('');
                setCustomBaseUrl('');
              }}
              placeholder={
                loadingProviders ? 'Loading providers...' : 'Select provider'
              }
              options={providers.map((entry) => ({
                value: entry.id,
                label: `${entry.name} (${entry.modelCount})${entry.configured ? ' - configured' : ''}`,
              }))}
            />
          </label>

          {customProvider ? (
            <>
              {customFactory && (
                <>
                  <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
                    Channel ID
                    <input
                      aria-label="Channel ID"
                      value={channelId}
                      onChange={(event) => {
                        setChannelId(event.target.value);
                        setLoadError(null);
                      }}
                      placeholder="team-gateway"
                      autoComplete="off"
                      spellCheck={false}
                      className="field"
                    />
                    <span className="text-[11px] text-zinc-400">
                      Stable config and credential identifier.
                    </span>
                  </label>
                  <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
                    Channel name
                    <input
                      aria-label="Channel name"
                      value={channelName}
                      onChange={(event) => setChannelName(event.target.value)}
                      placeholder="Team Gateway"
                      className="field"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
                    Base URL
                    <input
                      aria-label="Base URL"
                      value={customBaseUrl}
                      onChange={(event) => {
                        setCustomBaseUrl(event.target.value);
                        setLoadError(null);
                      }}
                      placeholder={
                        customFactory === 'anthropic-messages'
                          ? 'https://gateway.example.com'
                          : 'https://gateway.example.com/v1'
                      }
                      className="field"
                    />
                    <span className="text-[11px] text-zinc-400">
                      {customFactory === 'anthropic-messages'
                        ? 'Uses the Anthropic Messages protocol.'
                        : 'Uses the OpenAI Chat Completions protocol.'}
                    </span>
                  </label>
                </>
              )}
              <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
                Model ID
                <input
                  aria-label="Model ID"
                  value={customModelId}
                  onChange={(event) => {
                    setCustomModelId(event.target.value);
                    setLoadError(null);
                  }}
                  placeholder="vendor-model-2026"
                  className="field"
                />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
              Model
              <Select
                aria-label="Model"
                value={model?.id ?? ''}
                disabled={!provider || loadingModels}
                onChange={(val) => {
                  const selected = models.find((entry) => entry.id === val);
                  setModel(selected);
                  if (selected) setDisplayName(selected.name);
                }}
                placeholder={loadingModels ? 'Loading models...' : 'Select model'}
                options={models.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} - ${Math.round(entry.contextWindow / 1000)}K${entry.reasoning ? ' - reasoning' : ''}${entry.input.includes('image') ? ' - vision' : ''}`,
                }))}
              />
            </label>
          )}

          <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={model?.name ?? 'Optional alias'}
              className="field"
            />
          </label>

          {provider?.supportsApiKey && !provider.configured && (
            <label className="flex flex-col gap-2 text-[13px] font-mono text-zinc-500">
              API Key
              <span className="relative">
                <input
                  aria-label="API key"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="field w-full pr-10"
                  placeholder="Stored separately in auth.json"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded"
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </span>
            </label>
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
              saving ||
              !provider ||
              !selectedModelId ||
              (customFactory && (!channelId.trim() || !customBaseUrl.trim())) ||
              (!provider.configured &&
                (!provider.supportsApiKey || apiKey.trim().length === 0))
            }
            onClick={() => void submit()}
            className="flex min-h-9 items-center justify-center gap-2 rounded-md bg-green-600 px-4 py-2 font-mono text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Saving...' : 'Save Model'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
