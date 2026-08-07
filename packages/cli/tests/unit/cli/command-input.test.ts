import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginState = {
  initialize: vi.fn(),
  integrateAllPlugins: vi.fn(),
};

const slashState = {
  isSlashCommand: vi.fn(),
  executeSlashCommand: vi.fn(),
};

const mainInputState = {
  useInputHandler: undefined as
    | ((input: string, key: Record<string, boolean>) => void)
    | undefined,
  suggestions: [{ command: '/help', description: 'Show help', matchScore: 1 }],
};

const atCompletionState = {
  value: {
    hasQuery: false,
    query: '',
    startIndex: -1,
    endIndex: -1,
    quoted: false,
    suggestions: [] as string[],
    selectedIndex: 0,
    loading: false,
  },
  applySuggestion: vi.fn(),
};

const reactState = {
  useStateCallIndex: 0,
};

vi.mock('ahooks', () => ({
  useMemoizedFn: (fn: unknown) => fn,
}));

vi.mock('react', () => ({
  useEffect: vi.fn(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initialValue: unknown) => {
    const callIndex = reactState.useStateCallIndex++;

    if (callIndex === 0) {
      return [true, vi.fn()];
    }

    if (callIndex === 1) {
      return [mainInputState.suggestions, vi.fn()];
    }

    if (callIndex === 2) {
      return [0, vi.fn()];
    }

    return [initialValue, vi.fn()];
  },
}));

vi.mock('ink', () => ({
  useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
    mainInputState.useInputHandler = handler;
  },
}));

vi.mock('../../../src/plugins/index.js', () => ({
  getPluginRegistry: vi.fn(() => ({
    initialize: pluginState.initialize,
  })),
  integrateAllPlugins: pluginState.integrateAllPlugins,
}));

vi.mock('../../../src/slash-commands/index.js', () => ({
  isSlashCommand: slashState.isSlashCommand,
  executeSlashCommand: slashState.executeSlashCommand,
  getFuzzyCommandSuggestions: vi.fn(() => mainInputState.suggestions),
}));

vi.mock('../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => 'main_input',
  useSessionActions: () => ({
    clearMessages: vi.fn(),
    setError: vi.fn(),
    toggleThinkingExpanded: vi.fn(),
    toggleHistoryExpanded: vi.fn(),
  }),
  useAppActions: () => ({
    toggleThinkingMode: vi.fn(),
  }),
  useCurrentModel: () => undefined,
  useWorkspaceRoot: () => '/repo-root',
}));

vi.mock('../../../src/ui/hooks/useAtCompletion.js', () => ({
  useAtCompletion: () => atCompletionState.value,
  applySuggestion: atCompletionState.applySuggestion,
}));

vi.mock('../../../src/ui/hooks/useCtrlCHandler.js', () => ({
  useCtrlCHandler: () => vi.fn(),
}));

describe('command input helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginState.initialize.mockResolvedValue({ plugins: [] });
    pluginState.integrateAllPlugins.mockResolvedValue(undefined);
    slashState.isSlashCommand.mockReturnValue(false);
    mainInputState.useInputHandler = undefined;
    mainInputState.suggestions = [
      { command: '/help', description: 'Show help', matchScore: 1 },
    ];
    reactState.useStateCallIndex = 0;
    atCompletionState.value = {
      hasQuery: false,
      query: '',
      startIndex: -1,
      endIndex: -1,
      quoted: false,
      suggestions: [],
      selectedIndex: 0,
      loading: false,
    };
    atCompletionState.applySuggestion.mockReset();
  });

  it('initializes plugins and only integrates when plugins are present', async () => {
    const { initializeCliPlugins } = await import(
      '../../../src/commands/shared/commandInput.js'
    );

    await initializeCliPlugins();
    expect(pluginState.integrateAllPlugins).not.toHaveBeenCalled();

    pluginState.initialize.mockResolvedValueOnce({ plugins: [{ name: 'demo' }] });
    await initializeCliPlugins();
    expect(pluginState.integrateAllPlugins).toHaveBeenCalledTimes(1);
  });

  it('normalizes slash command requests into agent prompts', async () => {
    slashState.isSlashCommand.mockReturnValue(true);
    slashState.executeSlashCommand.mockResolvedValue({
      success: true,
      data: {
        action: 'invoke_skill',
        skillName: 'brainstorming',
        skillArgs: 'design a runner',
      },
    });

    const { normalizeCliInput } = await import(
      '../../../src/commands/shared/commandInput.js'
    );
    const result = await normalizeCliInput('/brainstorming design a runner');

    expect(result).toEqual({
      mode: 'agent',
      content: 'Please use the "brainstorming" skill to help me with: design a runner',
    });
  });

  it('prefers slash command content over short status messages', async () => {
    slashState.isSlashCommand.mockReturnValue(true);
    slashState.executeSlashCommand.mockResolvedValue({
      success: true,
      message: '帮助信息已显示',
      content: 'full help text',
    });

    const { normalizeCliInput } = await import(
      '../../../src/commands/shared/commandInput.js'
    );
    const result = await normalizeCliInput('/help');

    expect(result).toEqual({
      mode: 'output',
      content: 'full help text',
      exitCode: 0,
    });
  });

  it('accepts slash suggestion on Tab', async () => {
    const { useMainInput } = await import('../../../src/ui/hooks/useMainInput.js');

    const onSubmit = vi.fn();
    const onAddToHistory = vi.fn();
    const buffer = {
      value: '/he',
      cursorPosition: 3,
      setValue: vi.fn(),
      setCursorPosition: vi.fn(),
      clear: vi.fn(),
      pasteMap: new Map(),
      addPasteMapping: vi.fn(),
      addImagePasteMapping: vi.fn(),
      restorePasteMappings: vi.fn(),
      resolveInput: vi.fn((input: string) => ({
        displayText: input,
        text: input,
        images: [],
        parts: [{ type: 'text', text: input }],
      })),
    };

    useMainInput(
      buffer as any,
      onSubmit,
      () => null,
      () => null,
      onAddToHistory
    );

    expect(mainInputState.useInputHandler).toBeTypeOf('function');

    mainInputState.useInputHandler?.('', { tab: true });

    expect(buffer.setValue).toHaveBeenCalledWith('/help ');
    expect(buffer.setCursorPosition).toHaveBeenCalledWith('/help '.length);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts @ completion suggestion on Tab', async () => {
    const { useMainInput } = await import('../../../src/ui/hooks/useMainInput.js');

    atCompletionState.value = {
      hasQuery: true,
      query: 'fo',
      startIndex: 0,
      endIndex: 3,
      quoted: false,
      suggestions: ['foo.ts'],
      selectedIndex: 0,
      loading: false,
    };
    atCompletionState.applySuggestion.mockReturnValue({
      newInput: '@foo.ts ',
      newCursorPos: 8,
    });
    mainInputState.suggestions = [
      { command: 'foo.ts', description: 'File: foo.ts', matchScore: 1 },
    ];
    reactState.useStateCallIndex = 0;

    const onSubmit = vi.fn();
    const onAddToHistory = vi.fn();
    const buffer = {
      value: '@fo',
      cursorPosition: 3,
      setValue: vi.fn(),
      setCursorPosition: vi.fn(),
      clear: vi.fn(),
      pasteMap: new Map(),
      addPasteMapping: vi.fn(),
      addImagePasteMapping: vi.fn(),
      restorePasteMappings: vi.fn(),
      resolveInput: vi.fn((input: string) => ({
        displayText: input,
        text: input,
        images: [],
        parts: [{ type: 'text', text: input }],
      })),
    };

    useMainInput(
      buffer as any,
      onSubmit,
      () => null,
      () => null,
      onAddToHistory
    );

    mainInputState.useInputHandler?.('', { tab: true });

    expect(atCompletionState.applySuggestion).toHaveBeenCalledWith(
      '@fo',
      atCompletionState.value,
      'foo.ts'
    );
    expect(buffer.setValue).toHaveBeenCalledWith('@foo.ts ');
    expect(buffer.setCursorPosition).toHaveBeenCalledWith(8);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits @ completion input on Enter without applying suggestion', async () => {
    const { useMainInput } = await import('../../../src/ui/hooks/useMainInput.js');

    atCompletionState.value = {
      hasQuery: true,
      query: 'fo',
      startIndex: 0,
      endIndex: 3,
      quoted: false,
      suggestions: ['foo.ts'],
      selectedIndex: 0,
      loading: false,
    };
    atCompletionState.applySuggestion.mockReturnValue({
      newInput: '@foo.ts ',
      newCursorPos: 8,
    });
    mainInputState.suggestions = [
      { command: 'foo.ts', description: 'File: foo.ts', matchScore: 1 },
    ];
    reactState.useStateCallIndex = 0;

    const onSubmit = vi.fn();
    const onAddToHistory = vi.fn();
    const buffer = {
      value: '@fo',
      cursorPosition: 3,
      setValue: vi.fn(),
      setCursorPosition: vi.fn(),
      clear: vi.fn(),
      pasteMap: new Map(),
      addPasteMapping: vi.fn(),
      addImagePasteMapping: vi.fn(),
      restorePasteMappings: vi.fn(),
      resolveInput: vi.fn((input: string) => ({
        displayText: input,
        text: input,
        images: [],
        parts: [{ type: 'text', text: input }],
      })),
    };

    useMainInput(
      buffer as any,
      onSubmit,
      () => null,
      () => null,
      onAddToHistory
    );

    mainInputState.useInputHandler?.('', { return: true });

    expect(atCompletionState.applySuggestion).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      displayText: '@fo',
      text: '@fo',
    });
  });

  it('submits slash input on Enter even when suggestions are visible', async () => {
    const { useMainInput } = await import('../../../src/ui/hooks/useMainInput.js');

    const onSubmit = vi.fn();
    const onAddToHistory = vi.fn();
    const buffer = {
      value: '/he',
      cursorPosition: 3,
      setValue: vi.fn(),
      setCursorPosition: vi.fn(),
      clear: vi.fn(),
      pasteMap: new Map(),
      addPasteMapping: vi.fn(),
      addImagePasteMapping: vi.fn(),
      restorePasteMappings: vi.fn(),
      resolveInput: vi.fn((input: string) => ({
        displayText: input,
        text: input,
        images: [],
        parts: [{ type: 'text', text: input }],
      })),
    };

    useMainInput(
      buffer as any,
      onSubmit,
      () => null,
      () => null,
      onAddToHistory
    );

    expect(mainInputState.useInputHandler).toBeTypeOf('function');

    mainInputState.useInputHandler?.('', { return: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      displayText: '/he',
      text: '/he',
    });
  });
});
