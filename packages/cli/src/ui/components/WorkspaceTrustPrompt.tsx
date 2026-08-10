import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import type { WorkspaceTrustStatus } from '../../security/WorkspaceTrustService.js';
import { themeManager } from '../themes/ThemeManager.js';

interface WorkspaceTrustPromptProps {
  status: WorkspaceTrustStatus;
  onTrust: () => Promise<void>;
  onContinueSafely: () => Promise<void>;
}

export const WorkspaceTrustPrompt: React.FC<WorkspaceTrustPromptProps> = ({
  status,
  onTrust,
  onContinueSafely,
}) => {
  const theme = themeManager.getTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (busy) return;
    if (key.return || _input.toLowerCase() === 't') {
      setBusy(true);
      setError(null);
      void onTrust().catch((trustError) => {
        setError(
          trustError instanceof Error ? trustError.message : 'Failed to trust workspace'
        );
        setBusy(false);
      });
      return;
    }
    if (_input.toLowerCase() === 's' || key.escape) {
      setBusy(true);
      setError(null);
      void onContinueSafely().catch((safeError) => {
        setError(
          safeError instanceof Error ? safeError.message : 'Failed to continue safely'
        );
        setBusy(false);
      });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.colors.warning}>
        Workspace review required
      </Text>
      <Text dimColor>{status.projectPath}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          This project contains configuration that can change models, start MCP
          processes, relax permissions, inject environment variables, or load
          instructions, commands, skills, agents, and plugins.
        </Text>
        {status.sources.map((source) => (
          <Text key={`${source.kind}:${source.path}`}>
            {'  '}
            {source.path} · {source.effects.length} effect(s)
          </Text>
        ))}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>
          {busy
            ? 'Applying decision...'
            : '[Enter/T] Trust and load  [S/Esc] Continue safely'}
        </Text>
      </Box>
    </Box>
  );
};
