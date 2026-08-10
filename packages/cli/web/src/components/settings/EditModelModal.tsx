import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
      setCredentialError('Stream idle timeout must be at least 1000ms');
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
        error instanceof Error ? error.message : 'Failed to update provider credential'
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
        <DialogTitle className="sr-only">Edit Model</DialogTitle>
        <div className="flex items-center justify-between">
          <h2 className="font-mono font-semibold">Edit Model Overrides</h2>
          <button
            type="button"
            onClick={() => props.onOpenChange(false)}
            aria-label="Close edit model"
            className="flex h-8 w-8 items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" />
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
          Display name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Replace provider API key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Leave empty to keep current credential"
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Base URL override
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="Leave empty to use default endpoint"
            className="field"
          />
        </label>
        <label className="flex flex-col gap-2 font-mono text-sm">
          Stream idle timeout (ms)
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
          className="flex min-h-9 items-center justify-center gap-2 rounded-md bg-green-600 px-4 py-2 text-white disabled:opacity-60"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </DialogContent>
    </Dialog>
  );
}
