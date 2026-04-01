import { Box } from 'ink';
import React from 'react';
import { PermissionMode } from '../../config/types.js';
import { usePermissionMode } from '../../store/selectors/index.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { InputArea } from './InputArea.js';
import { LoadingIndicator } from './LoadingIndicator.js';
import { MessageArea } from './MessageArea.js';
import { SpecStatusPanel } from './SpecStatusPanel.js';
import { SubagentProgress } from './SubagentProgress.js';
import type { InputBuffer } from '../hooks/useInputBuffer.js';
import type { CommandSuggestion } from '../../slash-commands/types.js';

interface MainLayoutProps {
  inputBuffer: InputBuffer;
  showSuggestions: boolean;
  suggestions: CommandSuggestion[];
  selectedSuggestionIndex: number;
  hasBlockingModal: boolean;
  hasInlineModelUi: boolean;
  renderInlineModals: () => React.ReactNode;
  blockingModal: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  inputBuffer,
  showSuggestions,
  suggestions,
  selectedSuggestionIndex,
  hasBlockingModal,
  hasInlineModelUi,
  renderInlineModals,
  blockingModal,
}) => {
  const permissionMode = usePermissionMode();

  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      {blockingModal}

      <Box flexDirection="column" display={hasBlockingModal ? 'none' : 'flex'}>
        {permissionMode === PermissionMode.SPEC && <SpecStatusPanel />}

        <MessageArea />

        <SubagentProgress />

        <LoadingIndicator paused={hasBlockingModal} />

        <InputArea
          input={inputBuffer.value}
          cursorPosition={inputBuffer.cursorPosition}
          onChange={inputBuffer.setValue}
          onChangeCursorPosition={inputBuffer.setCursorPosition}
          onAddPasteMapping={inputBuffer.addPasteMapping}
          onAddImagePasteMapping={inputBuffer.addImagePasteMapping}
        />

        {renderInlineModals()}

        <CommandSuggestions
          suggestions={suggestions}
          selectedIndex={selectedSuggestionIndex}
          visible={showSuggestions && !hasInlineModelUi}
        />
        <ChatStatusBar />
      </Box>
    </Box>
  );
};
