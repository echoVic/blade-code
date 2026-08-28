import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  initialMcpElicitationContent,
  type McpElicitationContent,
  type McpElicitationDetails,
  type McpElicitationField,
  type McpElicitationResponse,
  parseMcpElicitationInput,
  validateMcpElicitationResponse,
} from '../../mcp/McpElicitation.js';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';
import { useTerminalInput as useInput } from '../input/TerminalInputRouter.js';

interface McpElicitationPromptProps {
  details: McpElicitationDetails;
  onComplete: (response: McpElicitationResponse, openExternalUrl?: boolean) => void;
}

type FormPhase = 'field' | 'review';

export const McpElicitationPrompt = React.memo<McpElicitationPromptProps>(
  ({ details, onComplete }) => {
    const { stdout } = useStdout();
    const terminalWidth = stdout.columns || 80;
    const isFocused = useCurrentFocus() === FocusId.CONFIRMATION_PROMPT;
    const handleCtrlC = useCtrlCHandler(false);
    const fields = details.fields ?? [];
    const [phase, setPhase] = useState<FormPhase>('field');
    const [fieldIndex, setFieldIndex] = useState(0);
    const [content, setContent] = useState<McpElicitationContent>(() =>
      initialMcpElicitationContent(details)
    );
    const [input, setInput] = useState('');
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [selectedValues, setSelectedValues] = useState<string[]>([]);
    const [error, setError] = useState<string>();
    const field = fields[fieldIndex];

    const options = useMemo(() => fieldOptions(field), [field]);

    useEffect(() => {
      if (!field) return;
      const current = content[field.name];
      setInput(
        typeof current === 'string' || typeof current === 'number'
          ? String(current)
          : ''
      );
      setSelectedValues(Array.isArray(current) ? [...current] : []);
      const selectedIndex = options.findIndex(
        (option) => option.value === String(current)
      );
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      setError(undefined);
    }, [content, field, options]);

    const moveNext = useCallback(
      (nextContent: McpElicitationContent) => {
        setContent(nextContent);
        if (fieldIndex < fields.length - 1) {
          setFieldIndex((index) => index + 1);
          return;
        }
        setPhase('review');
      },
      [fieldIndex, fields.length]
    );

    const submitFieldValue = useCallback(
      (value: string | number | boolean | string[] | undefined) => {
        if (!field) return;
        const next = { ...content };
        if (value === undefined) {
          delete next[field.name];
        } else {
          next[field.name] = value;
        }
        moveNext(next);
      },
      [content, field, moveNext]
    );

    const submitText = useCallback(
      (value: string) => {
        if (!field) return;
        try {
          submitFieldValue(parseMcpElicitationInput(field, value));
        } catch (submitError) {
          setError(
            submitError instanceof Error ? submitError.message : String(submitError)
          );
        }
      },
      [field, submitFieldValue]
    );

    const submitForm = useCallback(() => {
      try {
        const response = validateMcpElicitationResponse(details, {
          action: 'accept',
          content,
        });
        onComplete({
          action: response.action,
          ...(response.content ? { content: response.content } : {}),
        });
      } catch (submitError) {
        setError(
          submitError instanceof Error ? submitError.message : String(submitError)
        );
      }
    }, [content, details, onComplete]);

    useInput(
      (keyInput, key) => {
        if ((key.ctrl && keyInput === 'c') || (key.meta && keyInput === 'c')) {
          handleCtrlC();
          return;
        }
        if (key.escape) {
          onComplete({ action: 'cancel' });
          return;
        }
        if (details.mode === 'url') {
          if (keyInput.toLowerCase() === 'y') {
            onComplete({ action: 'accept' }, true);
          } else if (keyInput.toLowerCase() === 'n') {
            onComplete({ action: 'decline' });
          }
          return;
        }
        if (phase === 'review') {
          if (keyInput.toLowerCase() === 'y' || key.return) {
            submitForm();
          } else if (keyInput.toLowerCase() === 'e') {
            setFieldIndex(0);
            setPhase('field');
          } else if (keyInput.toLowerCase() === 'd') {
            onComplete({ action: 'decline' });
          }
          return;
        }
        if (!field) {
          if (key.return) submitForm();
          return;
        }
        if (isTextField(field)) return;
        if (keyInput.toLowerCase() === 'd') {
          onComplete({ action: 'decline' });
          return;
        }
        if (key.upArrow) {
          setHighlightedIndex((index) =>
            index > 0 ? index - 1 : Math.max(options.length - 1, 0)
          );
          return;
        }
        if (key.downArrow || key.tab) {
          setHighlightedIndex((index) => (index < options.length - 1 ? index + 1 : 0));
          return;
        }
        if (keyInput === ' ' && field.type === 'multi-select') {
          const selected = options[highlightedIndex];
          if (selected) {
            setSelectedValues((values) =>
              values.includes(selected.value)
                ? values.filter((value) => value !== selected.value)
                : [...values, selected.value]
            );
          }
          return;
        }
        if (key.return) {
          if (field.type === 'multi-select') {
            submitFieldValue(selectedValues);
          } else {
            const selected = options[highlightedIndex];
            if (selected) submitFieldValue(selected.typedValue);
          }
        }
      },
      { isActive: isFocused }
    );

    if (details.mode === 'url') {
      return (
        <PromptFrame width={terminalWidth} color="yellow">
          <Text bold color="yellow">
            MCP external authorization
          </Text>
          <Text>{details.message}</Text>
          <Text color="yellow">
            Only continue if you trust MCP server "{details.serverName}".
          </Text>
          <Text>
            Domain: <Text color="cyan">{details.domain}</Text>
          </Text>
          <Text wrap="wrap">
            URL: <Text color="cyan">{details.url}</Text>
          </Text>
          <Text color="gray">[Y] Open URL · [N] Decline · Esc Cancel</Text>
        </PromptFrame>
      );
    }

    if (phase === 'review') {
      return (
        <PromptFrame width={terminalWidth} color="green">
          <Text bold color="green">
            Review MCP form response
          </Text>
          <Text>{details.message}</Text>
          {fields.map((item) => (
            <Text key={item.name}>
              {item.title}: {formatValue(content[item.name])}
            </Text>
          ))}
          {error && <Text color="red">{error}</Text>}
          <Text color="gray">[Y] Submit · [E] Edit · [D] Decline · Esc Cancel</Text>
        </PromptFrame>
      );
    }

    if (!field) {
      return (
        <PromptFrame width={terminalWidth} color="cyan">
          <Text>{details.message}</Text>
          <Text color="gray">This form has no fields.</Text>
          <Text color="gray">Press Enter to submit · [D] Decline · Esc Cancel</Text>
        </PromptFrame>
      );
    }

    return (
      <PromptFrame width={terminalWidth} color="cyan">
        <Text bold color="cyan">
          MCP input requested by {details.serverName}
        </Text>
        <Text>{details.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            {field.title}
            {field.required ? ' *' : ''}
          </Text>
          {field.description && <Text color="gray">{field.description}</Text>}
          <Text color="gray">{fieldConstraint(field)}</Text>
        </Box>
        {isTextField(field) ? (
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submitText}
              focus={isFocused}
              placeholder={
                field.defaultValue === undefined
                  ? field.required
                    ? 'Required'
                    : 'Optional'
                  : String(field.defaultValue)
              }
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            {options.map((option, index) => {
              const selected =
                field.type === 'multi-select' && selectedValues.includes(option.value);
              return (
                <Text
                  key={option.value}
                  color={highlightedIndex === index ? 'yellow' : undefined}
                >
                  {highlightedIndex === index ? '> ' : '  '}
                  {field.type === 'multi-select' ? (selected ? '(*) ' : '( ) ') : ''}
                  {option.label}
                </Text>
              );
            })}
          </Box>
        )}
        {error && <Text color="red">{error}</Text>}
        <Text color="gray">
          {isTextField(field)
            ? 'Enter to continue'
            : field.type === 'multi-select'
              ? 'Space to toggle · Enter to continue'
              : 'Up/Down to select · Enter to continue'}
          {' · [D] Decline · Esc Cancel'}
        </Text>
        <Text color="gray">
          Field {fieldIndex + 1} of {fields.length}
        </Text>
      </PromptFrame>
    );
  }
);

function PromptFrame({
  children,
  width,
  color,
}: {
  children: React.ReactNode;
  width: number;
  color: string;
}) {
  return (
    <Box
      flexDirection="column"
      gap={1}
      borderStyle="round"
      borderColor={color}
      padding={1}
      width={Math.min(width - 4, 88)}
    >
      {children}
    </Box>
  );
}

function isTextField(field: McpElicitationField): boolean {
  return field.type === 'string' || field.type === 'number' || field.type === 'integer';
}

function fieldOptions(field: McpElicitationField | undefined): Array<{
  value: string;
  label: string;
  typedValue: string | boolean;
}> {
  if (!field) return [];
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

function fieldConstraint(field: McpElicitationField): string {
  const parts: string[] = [];
  if (field.format) parts.push(`format: ${field.format}`);
  if (field.minimum !== undefined) parts.push(`min: ${field.minimum}`);
  if (field.maximum !== undefined) parts.push(`max: ${field.maximum}`);
  if (field.minLength !== undefined) parts.push(`min length: ${field.minLength}`);
  if (field.maxLength !== undefined) parts.push(`max length: ${field.maxLength}`);
  if (field.minItems !== undefined) parts.push(`min selections: ${field.minItems}`);
  if (field.maxItems !== undefined) parts.push(`max selections: ${field.maxItems}`);
  return parts.join(' · ');
}

function formatValue(value: McpElicitationContent[string] | undefined): string {
  if (value === undefined) return '(omitted)';
  if (Array.isArray(value)) return value.join(', ') || '(none)';
  return String(value);
}
