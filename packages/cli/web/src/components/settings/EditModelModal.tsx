import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { ModelConfig } from '@/store/ConfigStore';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface EditModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelConfig | null;
  onSave: (modelId: string, updates: Partial<ModelConfig>) => void;
}

export function EditModelModal(props: EditModelModalProps) {
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    setDisplayName(props.model?.displayName ?? '');
    setBaseUrl(props.model?.overrides?.baseUrl ?? '');
  }, [props.model]);

  const save = async () => {
    if (!props.model) return;
    if (apiKey.trim()) {
      const response = await fetch(`/providers/${props.model.provider}/credential`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      if (!response.ok) throw new Error('Failed to update provider credential');
    }
    props.onSave(props.model.id, {
      displayName: displayName || undefined,
      overrides: baseUrl ? { ...props.model.overrides, baseUrl } : undefined,
    });
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] p-6 bg-white dark:bg-[#09090b]"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Edit Model</DialogTitle>
        <div className="flex justify-between">
          <h2 className="font-semibold font-mono">Edit Model Overrides</h2>
          <button type="button" onClick={() => props.onOpenChange(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="font-mono text-sm">Display name</label>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="field"
        />
        <label className="font-mono text-sm">Replace provider API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Leave empty to keep current credential"
          className="field"
        />
        <label className="font-mono text-sm">Base URL override</label>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="Leave empty to use default endpoint"
          className="field"
        />
        <button
          type="button"
          onClick={() => void save()}
          className="px-4 py-2 rounded-md text-white bg-green-600"
        >
          Save
        </button>
      </DialogContent>
    </Dialog>
  );
}
