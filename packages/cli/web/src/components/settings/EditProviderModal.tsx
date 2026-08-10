import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
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
  const t = useT();
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
      setError(t('settings.models.editProvider.channelNameRequired'));
      return;
    }
    try {
      const parsed = new URL(baseUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      setError(t('settings.models.editProvider.invalidBaseUrl'));
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
        <DialogTitle className="sr-only">
          {t('settings.models.editProvider.title')}
        </DialogTitle>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono font-semibold">
              {t('settings.models.editProvider.title')}
            </h2>
            <p className="mt-1 font-mono text-[11px] text-zinc-400">{provider.id}</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t('settings.models.editProvider.close')}
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
          {t('settings.models.editProvider.channelName')}
          <input
            aria-label={t('settings.models.editProvider.channelName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editProvider.wireApi')}
          <Select
            aria-label={t('settings.models.editProvider.wireApi')}
            value={wireApi}
            onChange={(val) =>
              setWireApi(val as 'openai-completions' | 'anthropic-messages')
            }
            options={[
              { value: 'openai-completions', label: 'OpenAI Chat Completions' },
              { value: 'anthropic-messages', label: 'Anthropic Messages' },
            ]}
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editProvider.baseUrl')}
          <input
            aria-label={t('settings.models.editProvider.baseUrlAria')}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
            }}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editProvider.apiKeyEnv')}
          <input
            aria-label={t('settings.models.editProvider.apiKeyEnv')}
            value={apiKeyEnv}
            onChange={(event) => setApiKeyEnv(event.target.value)}
            placeholder={t('settings.models.editProvider.apiKeyEnvPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editProvider.replaceApiKey')}
          <input
            aria-label={t('settings.models.editProvider.apiKeyAria')}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('settings.models.editProvider.apiKeyPlaceholder')}
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
          {saving
            ? t('settings.models.editProvider.saving')
            : t('settings.models.editProvider.save')}
        </button>
      </DialogContent>
    </Dialog>
  );
}
