import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { requestJson } from '@/lib/http';
import { restoreFocusToSelector } from '@/lib/mobileNavigationFocus';
import type { ModelConfig } from '@/store/ConfigStore';

interface EditModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelConfig | null;
  onSave: (modelId: string, updates: Partial<ModelConfig>) => Promise<boolean>;
  saveError: string | null;
}

export function EditModelModal(props: EditModelModalProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [streamIdleTimeout, setStreamIdleTimeout] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(props.model?.displayName ?? '');
    setBaseUrl(props.model?.overrides?.baseUrl ?? '');
    setStreamIdleTimeout(
      props.model?.overrides?.streamIdleTimeout !== undefined
        ? String(props.model.overrides.streamIdleTimeout)
        : ''
    );
    setApiKey('');
    setCredentialError(null);
  }, [props.model]);

  const save = async () => {
    if (!props.model) return;
    setCredentialError(null);
    const parsedStreamIdleTimeout = streamIdleTimeout.trim()
      ? Number(streamIdleTimeout)
      : undefined;
    if (
      parsedStreamIdleTimeout !== undefined &&
      (!Number.isFinite(parsedStreamIdleTimeout) || parsedStreamIdleTimeout < 1_000)
    ) {
      setCredentialError(t('settings.models.editModal.streamIdleTimeoutError'));
      return;
    }
    setSaving(true);
    try {
      if (apiKey.trim()) {
        await requestJson(`/providers/${props.model.provider}/credential`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        });
      }
      const overrides = { ...props.model.overrides };
      if (baseUrl.trim()) overrides.baseUrl = baseUrl.trim();
      else delete overrides.baseUrl;
      if (parsedStreamIdleTimeout !== undefined) {
        overrides.streamIdleTimeout = parsedStreamIdleTimeout;
      } else {
        delete overrides.streamIdleTimeout;
      }
      const saved = await props.onSave(props.model.id, {
        displayName: displayName || undefined,
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      if (saved) props.onOpenChange(false);
    } catch (error) {
      setCredentialError(
        error instanceof Error
          ? error.message
          : t('settings.models.editModal.credentialError')
      );
    } finally {
      setSaving(false);
    }
  };

  const triggerSelector = props.model
    ? `[data-edit-model-trigger="${props.model.id.replace(/"/g, '\\"')}"]`
    : '[data-edit-model-trigger]';

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => restoreFocusToSelector(triggerSelector, event)}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          props.onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          props.onOpenChange(false);
        }}
        className="gap-4 overflow-y-auto bg-white p-4 dark:bg-[#09090b] sm:max-w-[480px] sm:p-6"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">
          {t('settings.models.editModal.srTitle')}
        </DialogTitle>
        <div className="flex justify-between items-center">
          <h2 className="font-mono font-semibold">
            {t('settings.models.editModal.title')}
          </h2>
          <button
            type="button"
            onClick={() => props.onOpenChange(false)}
            aria-label={t('settings.models.editModal.close')}
            className="flex justify-center items-center w-8 h-8 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(credentialError || props.saveError) && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
          >
            {credentialError || props.saveError}
          </div>
        )}

        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editModal.displayName')}
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editModal.replaceApiKey')}
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('settings.models.editModal.replaceApiKeyPlaceholder')}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editModal.baseUrlOverride')}
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={t('settings.models.editModal.baseUrlPlaceholder')}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          {t('settings.models.editModal.streamIdleTimeout')}
          <input
            type="number"
            min={1000}
            step={1000}
            value={streamIdleTimeout}
            onChange={(event) => setStreamIdleTimeout(event.target.value)}
            placeholder="300000"
            className="field"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="flex gap-2 justify-center items-center px-4 py-2 text-white bg-green-600 rounded-md min-h-9 disabled:opacity-60"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving
            ? t('settings.models.editModal.saving')
            : t('settings.models.editModal.save')}
        </button>
      </DialogContent>
    </Dialog>
  );
}
