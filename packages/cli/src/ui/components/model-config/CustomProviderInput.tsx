import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useState } from 'react';
import {
  MODEL_PROVIDER_ID_PATTERN,
  validateModelProviderConfig,
} from '../../../config/modelProviders.js';
import type { ModelProviderWireApi, SetupConfig } from '../../../config/types.js';

type Field = 'id' | 'name' | 'baseUrl' | 'model';

const FIELDS: readonly Field[] = ['id', 'name', 'baseUrl', 'model'];

interface CustomProviderInputProps {
  wireApi: ModelProviderWireApi;
  initialConfig?: SetupConfig;
  onSubmit: (config: SetupConfig) => void;
  onCancel: () => void;
}

interface Draft {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

function fieldLabel(field: Field): string {
  switch (field) {
    case 'id':
      return 'Channel ID';
    case 'name':
      return 'Channel name';
    case 'baseUrl':
      return 'Base URL';
    case 'model':
      return 'Model ID';
  }
}

function fieldPlaceholder(
  field: Field,
  wireApi: ModelProviderWireApi,
  channelId: string
): string {
  switch (field) {
    case 'id':
      return 'team-gateway';
    case 'name':
      return channelId || 'Team Gateway';
    case 'baseUrl':
      return wireApi === 'anthropic-messages'
        ? 'https://gateway.example.com'
        : 'https://gateway.example.com/v1';
    case 'model':
      return wireApi === 'anthropic-messages' ? 'claude-opus-4-8' : 'vendor-model-2026';
  }
}

export function buildCustomProviderSetup(
  draft: Draft,
  wireApi: ModelProviderWireApi
): SetupConfig {
  const provider = draft.id.trim();
  const modelProvider = {
    name: draft.name.trim() || provider,
    baseUrl: draft.baseUrl.trim(),
    wireApi,
  };
  const errors = validateModelProviderConfig(provider, modelProvider);
  if (!draft.model.trim()) errors.push('Model ID must not be empty');
  if (errors.length > 0) throw new Error(errors[0]);

  return {
    provider,
    model: draft.model.trim(),
    displayName: draft.model.trim(),
    modelProvider,
  };
}

export const CustomProviderInput: React.FC<CustomProviderInputProps> = ({
  wireApi,
  initialConfig,
  onSubmit,
  onCancel,
}) => {
  const initialDraft: Draft = {
    id: initialConfig?.provider ?? '',
    name: initialConfig?.modelProvider?.name ?? '',
    baseUrl: initialConfig?.modelProvider?.baseUrl ?? '',
    model: initialConfig?.model ?? '',
  };
  const [fieldIndex, setFieldIndex] = useState(initialConfig ? 3 : 0);
  const [value, setValue] = useState(initialConfig?.model ?? '');
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [error, setError] = useState<string>();
  const field = FIELDS[fieldIndex]!;

  useInput((_input, key) => {
    if (!key.escape) return;
    setError(undefined);
    if (fieldIndex === 0) {
      onCancel();
      return;
    }
    const previousIndex = fieldIndex - 1;
    const previousField = FIELDS[previousIndex]!;
    setFieldIndex(previousIndex);
    setValue(draft[previousField]);
  });

  const advance = (input: string) => {
    const normalized = input.trim();
    if (field === 'id' && !MODEL_PROVIDER_ID_PATTERN.test(normalized)) {
      setError('Channel ID 必须以小写字母开头，且仅包含小写字母、数字、.、_ 或 -');
      return;
    }
    if (field === 'baseUrl') {
      try {
        const url = new URL(normalized);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setError('Base URL 必须是绝对 HTTP(S) URL');
        return;
      }
    }
    if (field === 'model' && !normalized) {
      setError('Model ID 不能为空');
      return;
    }

    const nextDraft = {
      ...draft,
      [field]: field === 'name' && !normalized ? draft.id : normalized,
    };
    setDraft(nextDraft);
    setError(undefined);
    if (fieldIndex === FIELDS.length - 1) {
      try {
        onSubmit(buildCustomProviderSetup(nextDraft, wireApi));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '渠道配置无效');
      }
      return;
    }
    setFieldIndex(fieldIndex + 1);
    setValue('');
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          配置自定义 Provider 渠道
        </Text>
      </Box>
      <Text dimColor>
        Protocol:{' '}
        {wireApi === 'anthropic-messages'
          ? 'Anthropic Messages'
          : 'OpenAI Chat Completions'}
      </Text>
      {FIELDS.slice(0, fieldIndex).map((completed) => (
        <Text key={completed}>
          {fieldLabel(completed)}: <Text color="cyan">{draft[completed]}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold>{fieldLabel(field)}: </Text>
        <TextInput
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(undefined);
          }}
          onSubmit={advance}
          placeholder={fieldPlaceholder(field, wireApi, draft.id)}
        />
      </Box>
      {field === 'name' && <Text dimColor>留空使用 Channel ID</Text>}
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1}>
        <Text dimColor>Enter 继续 · Esc 返回</Text>
      </Box>
    </Box>
  );
};
