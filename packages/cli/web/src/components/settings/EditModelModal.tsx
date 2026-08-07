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
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(props.model?.displayName ?? '');
    setBaseUrl(props.model?.overrides?.baseUrl ?? '');
    setApiKey('');
    setCredentialError(null);
  }, [props.model]);

  const save = async () => {
    if (!props.model) return;
    setSaving(true);
    setCredentialError(null);
    try {
      if (apiKey.trim()) {
        await requestJson(`/providers/${props.model.provider}/credential`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        });
      }
      const saved = await props.onSave(props.model.id, {
        displayName: displayName || undefined,
        overrides: baseUrl ? { ...props.model.overrides, baseUrl } : undefined,
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
