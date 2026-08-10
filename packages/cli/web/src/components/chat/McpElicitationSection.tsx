import type { McpElicitationContentValue, McpElicitationField } from '@api/schemas';
import { ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { sessionService } from '@/services';
import type { AgentResponseContent } from '@/store/session';
import { useSessionStore } from '@/store/session';

interface McpElicitationSectionProps {
  elicitation: NonNullable<AgentResponseContent['elicitation']>;
  messageId: string;
}

type FormContent = Record<string, McpElicitationContentValue>;

export function McpElicitationSection({
  elicitation,
  messageId,
}: McpElicitationSectionProps) {
  const t = useT();
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const setElicitation = useSessionStore((state) => state.setElicitation);
  const [values, setValues] = useState<FormContent>(() =>
    initialValues(elicitation.details.fields ?? [])
  );
  const [rawInputs, setRawInputs] = useState<Record<string, string>>(() =>
    initialRawInputs(elicitation.details.fields ?? [])
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const fields = elicitation.details.fields ?? [];

  const requiredFieldsComplete = useMemo(
    () =>
      fields.every((field) => {
        if (!field.required) return true;
        if (isTextField(field)) {
          return Boolean(
            rawInputs[field.name]?.trim() || field.defaultValue !== undefined
          );
        }
        const value = values[field.name] ?? field.defaultValue;
        return Array.isArray(value) ? value.length > 0 : value !== undefined;
      }),
    [fields, rawInputs, values]
  );

  if (elicitation.status !== 'pending') {
    return (
      <div className="rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2 font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
        {t(
          elicitation.status === 'cancelled'
            ? 'interaction.elicitation.cancelled'
            : 'interaction.elicitation.responded'
        )}
      </div>
    );
  }

  const respond = async (
    action: 'accept' | 'decline' | 'cancel',
    content?: FormContent
  ) => {
    if (!currentSessionRef || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await sessionService.respondToElicitation(
        currentSessionRef,
        elicitation.toolCallId,
        {
          action,
          ...(content ? { content } : {}),
        }
      );
      setElicitation(messageId, {
        ...elicitation,
        status: 'responded',
      });
    } catch (responseError) {
      setError(
        responseError instanceof Error
          ? responseError.message
          : t('interaction.elicitation.failed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const submitForm = async () => {
    try {
      await respond('accept', buildContent(fields, values, rawInputs));
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : String(validationError)
      );
    }
  };

  const openUrl = () => {
    const url = elicitation.details.url;
    if (!url) {
      setError('MCP URL is unavailable');
      return;
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      setError('The browser blocked the external window');
      return;
    }
    void respond('accept');
  };

  return (
    <div
      data-pending-interaction="elicitation"
      tabIndex={-1}
      role="alert"
      className="space-y-4 rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800/70 dark:bg-amber-950/25"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 space-y-1">
          <div className="font-mono text-[12px] font-semibold text-[hsl(var(--deck-ink))]">
            {t('interaction.elicitation.title')} · {elicitation.details.serverName}
          </div>
          <div className="font-mono text-[12px] text-[hsl(var(--deck-ink-muted))]">
            {elicitation.details.message}
          </div>
          <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
            {t('interaction.elicitation.warning')}
          </div>
        </div>
      </div>

      {elicitation.details.mode === 'url' ? (
        <div className="space-y-3">
          <div className="rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] p-3 font-mono text-[11px]">
            <div className="text-[hsl(var(--deck-ink-muted))]">
              {elicitation.details.domain}
            </div>
            <div className="mt-1 break-all text-[hsl(var(--deck-ink))]">
              {elicitation.details.url}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              onClick={openUrl}
              disabled={submitting}
              primary
              label={t('interaction.elicitation.open')}
              icon={<ExternalLink className="h-3.5 w-3.5" />}
            />
            <ActionButton
              onClick={() => void respond('decline')}
              disabled={submitting}
              label={t('interaction.elicitation.decline')}
            />
            <ActionButton
              onClick={() => void respond('cancel')}
              disabled={submitting}
              label={t('interaction.elicitation.cancel')}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field) => (
            <FormField
              key={field.name}
              field={field}
              value={values[field.name]}
              rawValue={rawInputs[field.name] ?? ''}
              onValueChange={(value) =>
                setValues((current) => ({ ...current, [field.name]: value }))
              }
              onRawChange={(value) =>
                setRawInputs((current) => ({
                  ...current,
                  [field.name]: value,
                }))
              }
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <ActionButton
              onClick={() => void submitForm()}
              disabled={submitting || !requiredFieldsComplete}
              primary
              label={t('interaction.elicitation.submit')}
              icon={
                submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null
              }
            />
            <ActionButton
              onClick={() => void respond('decline')}
              disabled={submitting}
              label={t('interaction.elicitation.decline')}
            />
            <ActionButton
              onClick={() => void respond('cancel')}
              disabled={submitting}
              label={t('interaction.elicitation.cancel')}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300/70 bg-red-50 px-2.5 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

function FormField({
  field,
  value,
  rawValue,
  onValueChange,
  onRawChange,
}: {
  field: McpElicitationField;
  value: McpElicitationContentValue | undefined;
  rawValue: string;
  onValueChange: (value: McpElicitationContentValue) => void;
  onRawChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={`mcp-elicitation-${field.name}`}
        className="block font-mono text-[12px] font-medium text-[hsl(var(--deck-ink))]"
      >
        {field.title}
        {field.required ? ' *' : ''}
      </label>
      {field.description && (
        <div className="font-mono text-[11px] text-[hsl(var(--deck-ink-faint))]">
          {field.description}
        </div>
      )}
      {field.type === 'select' ||
      field.type === 'multi-select' ||
      field.type === 'boolean' ? (
        <div id={`mcp-elicitation-${field.name}`} className="flex flex-wrap gap-2">
          {fieldOptions(field).map((option) => {
            const selected = Array.isArray(value)
              ? value.includes(option.value)
              : value === option.typedValue;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  if (field.type === 'multi-select') {
                    const current = Array.isArray(value) ? value : [];
                    onValueChange(
                      current.includes(option.value)
                        ? current.filter((item) => item !== option.value)
                        : [...current, option.value]
                    );
                  } else {
                    onValueChange(option.typedValue);
                  }
                }}
                className={cn(
                  'rounded-md border px-3 py-2 font-mono text-[12px] transition-colors',
                  selected
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                    : 'border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] text-[hsl(var(--deck-ink-muted))] hover:text-[hsl(var(--deck-ink))]'
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          id={`mcp-elicitation-${field.name}`}
          type={inputType(field)}
          value={rawValue}
          onChange={(event) => onRawChange(event.target.value)}
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          required={field.required}
          placeholder={
            field.defaultValue === undefined
              ? field.required
                ? 'Required'
                : 'Optional'
              : String(field.defaultValue)
          }
          className="w-full rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2 font-mono text-[12px] text-[hsl(var(--deck-ink))] outline-none transition-colors focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
        />
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  primary = false,
  label,
  icon,
}: {
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[12px] transition-colors disabled:cursor-wait disabled:opacity-50',
        primary
          ? 'bg-amber-600 text-white hover:bg-amber-700'
          : 'border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] text-[hsl(var(--deck-ink-muted))] hover:text-[hsl(var(--deck-ink))]'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function initialValues(fields: McpElicitationField[]): FormContent {
  return Object.fromEntries(
    fields
      .filter((field) => !isTextField(field) && field.defaultValue !== undefined)
      .map((field) => [
        field.name,
        Array.isArray(field.defaultValue)
          ? [...field.defaultValue]
          : field.defaultValue!,
      ])
  );
}

function initialRawInputs(fields: McpElicitationField[]): Record<string, string> {
  return Object.fromEntries(
    fields
      .filter((field) => isTextField(field) && field.defaultValue !== undefined)
      .map((field) => [field.name, String(field.defaultValue)])
  );
}

function buildContent(
  fields: McpElicitationField[],
  values: FormContent,
  rawInputs: Record<string, string>
): FormContent {
  const content: FormContent = {};
  for (const field of fields) {
    if (isTextField(field)) {
      const raw = rawInputs[field.name]?.trim() ?? '';
      if (!raw) {
        if (field.defaultValue !== undefined) {
          content[field.name] = field.defaultValue;
        } else if (field.required) {
          throw new Error(`${field.title} is required`);
        }
        continue;
      }
      if (field.type === 'number' || field.type === 'integer') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`${field.title} must be a finite number`);
        }
        if (field.type === 'integer' && !Number.isSafeInteger(parsed)) {
          throw new Error(`${field.title} must be a safe integer`);
        }
        content[field.name] = parsed;
      } else {
        content[field.name] = raw;
      }
      continue;
    }

    const value = values[field.name] ?? field.defaultValue;
    if (value === undefined) {
      if (field.required) throw new Error(`${field.title} is required`);
      continue;
    }
    if (Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems) {
        throw new Error(`${field.title} requires at least ${field.minItems} choices`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        throw new Error(`${field.title} allows at most ${field.maxItems} choices`);
      }
    }
    content[field.name] = value;
  }
  return content;
}

function fieldOptions(field: McpElicitationField): Array<{
  value: string;
  label: string;
  typedValue: string | boolean;
}> {
  if (field.type === 'boolean') {
    return [
      { value: 'true', label: 'Yes', typedValue: true },
      { value: 'false', label: 'No', typedValue: false },
    ];
  }
  return (field.options ?? []).map((option) => ({
    ...option,
    typedValue: option.value,
  }));
}

function isTextField(field: McpElicitationField): boolean {
  return field.type === 'string' || field.type === 'number' || field.type === 'integer';
}

function inputType(field: McpElicitationField): string {
  if (field.type === 'number' || field.type === 'integer') return 'number';
  if (field.format === 'email') return 'email';
  if (field.format === 'uri') return 'url';
  if (field.format === 'date') return 'date';
  if (field.format === 'date-time') return 'datetime-local';
  return 'text';
}
