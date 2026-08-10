import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { restoreFocusToSelector } from '@/lib/mobileNavigationFocus';

export interface ProviderChannel {
  id: string;
  name: string;
  modelCount: number;
  defaultBaseUrl?: string;
  supportsApiKey: boolean;
  configured: boolean;
  custom: boolean;
  wireApi?: 'openai-completions' | 'anthropic-messages';
  apiKeyEnv?: string;
}

export interface ProviderChannelUpdate {
  name: string;
  baseUrl: string;
  wireApi: 'openai-completions' | 'anthropic-messages';
  apiKeyEnv: string | null;
  apiKey?: string;
}

interface EditProviderModalProps {
  provider: ProviderChannel;
  onOpenChange: (open: boolean) => void;
  onSave: (providerId: string, update: ProviderChannelUpdate) => Promise<boolean>;
  saveError: string | null;
}

export function EditProviderModal({
  provider,
  onOpenChange,
  onSave,
  saveError,
}: EditProviderModalProps) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.defaultBaseUrl ?? '');
  const [wireApi, setWireApi] = useState<'openai-completions' | 'anthropic-messages'>(
    provider.wireApi ?? 'openai-completions'
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.apiKeyEnv ?? '');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.defaultBaseUrl ?? '');
    setWireApi(provider.wireApi ?? 'openai-completions');
    setApiKeyEnv(provider.apiKeyEnv ?? '');
    setApiKey('');
    setError(null);
  }, [provider]);

  const save = async () => {
    if (!name.trim()) {
      setError('Channel name is required');
      return;
    }
    try {
      const parsed = new URL(baseUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      setError('Base URL must be an absolute HTTP(S) URL');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await onSave(provider.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        wireApi,
        apiKeyEnv: apiKeyEnv.trim() || null,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) =>
          restoreFocusToSelector(
            `[data-edit-provider-trigger="${provider.id.replace(/"/g, '\\"')}"]`,
            event
          )
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
        className="gap-4 overflow-y-auto bg-white p-4 dark:bg-[#09090b] sm:max-w-[480px] sm:p-6"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Edit Provider Channel</DialogTitle>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono font-semibold">Edit Provider Channel</h2>
            <p className="mt-1 font-mono text-[11px] text-zinc-400">{provider.id}</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close edit provider"
            className="flex h-8 w-8 items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {(error || saveError) && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
          >
            {error || saveError}
          </div>
        )}

        <label className="flex flex-col gap-2 font-mono text-sm">
          Channel name
          <input
            aria-label="Channel name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Wire API
          <select
            aria-label="Wire API"
            value={wireApi}
            onChange={(event) =>
              setWireApi(
                event.target.value as 'openai-completions' | 'anthropic-messages'
              )
            }
            className="field"
          >
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Base URL
          <input
            aria-label="Provider Base URL"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
            }}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          API key environment variable
          <input
            aria-label="API key environment variable"
            value={apiKeyEnv}
            onChange={(event) => setApiKeyEnv(event.target.value)}
            placeholder="Optional, for example TEAM_GATEWAY_API_KEY"
            autoComplete="off"
            spellCheck={false}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Replace API key
          <input
            aria-label="Provider API key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Leave empty to keep current credential"
            className="field"
          />
        </label>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="flex min-h-9 items-center justify-center gap-2 rounded-md bg-green-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving...' : 'Save channel'}
        </button>
      </DialogContent>
    </Dialog>
  );
}
