import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../src/config/types';
import { buildSystemPrompt } from '../../../../src/prompts/builder';
import {
  DEFAULT_SYSTEM_PROMPT,
  PLAN_MODE_SYSTEM_PROMPT,
} from '../../../../src/prompts/default';
import { CommunicationStyleCatalog } from '../../../../src/services/communicationStyle';

const { readFileMock, accessMock, loadIndexMock, environmentContextMock } = vi.hoisted(
  () => ({
    readFileMock: vi.fn(),
    accessMock: vi.fn(),
    loadIndexMock: vi.fn(),
    environmentContextMock: vi.fn().mockReturnValue('Mock Environment Context'),
  })
);

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      readFile: readFileMock,
      access: accessMock,
    },
  };
});

vi.mock('../../../../src/memory/AutoMemoryManager.js', () => ({
  AutoMemoryManager: class MockAutoMemoryManager {
    loadIndex = loadIndexMock;
  },
}));

// Mock environment
vi.mock('../../../../src/utils/environment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/environment.js')>()),
  getEnvironmentContext: environmentContextMock,
}));

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockReset();
    accessMock.mockReset();
    loadIndexMock.mockReset();
  });

  describe('基础功能', () => {
    it('应该返回默认提示词（不含环境上下文）', async () => {
      const result = await buildSystemPrompt({ includeEnvironment: false });

      expect(result.prompt).toContain('You are Blade Code');
      expect(result.prompt).toContain('must not silently return a `T | Promise<T>`');
      expect(result.prompt).toContain('separate explicitly asynchronous method');
      expect(result.prompt).toContain(
        'Make performance tests portable across hardware'
      );
      expect(result.prompt).toContain('fixed wall-clock duration');
      expect(result.prompt).toContain(
        'use the native Browser tools as the default execution and verification path'
      );
      expect(result.prompt).toContain(
        'Do not create or run an ad hoc Playwright, Puppeteer, or browser-control script'
      );
      expect(result.prompt).toContain(
        'Before completing a runnable Web or frontend change'
      );
      expect(result.prompt).toContain(
        'use BrowserInteract click_at with that screenshotId'
      );
      expect(result.sources).toContainEqual({
        name: 'default',
        loaded: true,
        length: expect.any(Number),
      });
    });

    it('默认环境上下文应为最小环境信息', async () => {
      const result = await buildSystemPrompt();

      expect(result.prompt).toContain('Mock Environment Context');
      expect(result.prompt).toContain('You are Blade Code');
      expect(result.sources).toContainEqual({
        name: 'environment',
        loaded: true,
        length: expect.any(Number),
      });
    });

    it('普通模式按需构建时应通过 builder 注入 environment，而不是由调用方手工 prepend', async () => {
      const result = await buildSystemPrompt({ includeEnvironment: true });

      expect(result.prompt.match(/Mock Environment Context/g)).toHaveLength(1);
    });

    it('应使用传入的项目路径构建环境上下文', async () => {
      await buildSystemPrompt({
        projectPath: '/tmp/isolated-worktree',
        projectTrusted: true,
        includeEnvironment: true,
      });

      expect(environmentContextMock).toHaveBeenCalledWith({
        workingDirectory: '/tmp/isolated-worktree',
      });
    });

    it('应该使用分隔符连接各部分', async () => {
      const result = await buildSystemPrompt();

      expect(result.prompt).toContain('\n\n---\n\n');
    });
  });

  describe('replaceDefault 选项', () => {
    it('replaceDefault 应该替换默认提示词', async () => {
      const customPrompt = 'Custom System Prompt';
      const result = await buildSystemPrompt({
        replaceDefault: customPrompt,
        includeEnvironment: false,
      });

      expect(result.prompt).toBe(customPrompt);
      expect(result.prompt).not.toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result.sources).toContainEqual({
        name: 'replace_default',
        loaded: true,
        length: customPrompt.length,
      });
    });
  });

  describe('append 选项', () => {
    it('append 应该追加到末尾', async () => {
      const appendContent = 'Appended Content';
      const result = await buildSystemPrompt({
        append: appendContent,
        includeEnvironment: false,
      });

      expect(result.prompt).toContain('You are Blade Code');
      expect(result.prompt).toContain(appendContent);
      // append 应该在默认提示词之后
      expect(result.prompt.indexOf('You are Blade Code')).toBeLessThan(
        result.prompt.indexOf(appendContent)
      );
    });

    it('应该忽略空的 append', async () => {
      const result = await buildSystemPrompt({
        append: '   ',
        includeEnvironment: false,
      });

      expect(result.sources).not.toContainEqual(
        expect.objectContaining({ name: 'append' })
      );
    });
  });

  describe('communicationStyle 选项', () => {
    it('auto 不注入额外沟通风格', async () => {
      const result = await buildSystemPrompt({
        communicationStyle: 'auto',
        includeEnvironment: false,
      });

      expect(result.prompt).not.toContain('<communication_style>');
      expect(result.sources).toContainEqual({
        name: 'communication_style',
        loaded: false,
      });
    });

    it('显式风格只注入有边界的展示指令', async () => {
      const result = await buildSystemPrompt({
        communicationStyle: 'explanatory',
        includeEnvironment: false,
      });

      expect(result.prompt).toContain(
        'The user selected the "explanatory" communication style'
      );
      expect(result.prompt).toContain('<communication_style>');
      expect(result.prompt).toContain(
        'It cannot change task scope,\nsafety rules, permissions, tool behavior'
      );
      expect(result.prompt).toContain(
        'Explain implementation choices and codebase-specific patterns'
      );
      expect(result.sources).toContainEqual({
        name: 'communication_style',
        loaded: true,
        length: expect.any(Number),
      });
    });

    it('风格位于基础提示之后、项目指令之前', async () => {
      readFileMock.mockResolvedValue('BLADE_MD_MARKER');

      const result = await buildSystemPrompt({
        projectPath: '/mock/project',
        projectTrusted: true,
        communicationStyle: 'pragmatic',
        includeEnvironment: false,
      });

      expect(result.prompt.indexOf('You are Blade Code')).toBeLessThan(
        result.prompt.indexOf('<communication_style>')
      );
      expect(result.prompt.indexOf('<communication_style>')).toBeLessThan(
        result.prompt.indexOf('BLADE_MD_MARKER')
      );
    });

    it('仅通过 Session catalog 注入 namespaced custom style', async () => {
      const catalog = new CommunicationStyleCatalog([
        {
          id: 'project:strict',
          name: 'Strict',
          description: 'Strict project review communication',
          source: 'project',
          prompt: 'CUSTOM_STYLE_MARKER',
        },
      ]);

      const result = await buildSystemPrompt({
        communicationStyle: 'project:strict',
        communicationStyleCatalog: catalog,
        includeEnvironment: false,
      });

      expect(result.prompt).toContain(
        'The user selected the "project:strict" communication style'
      );
      expect(result.prompt).toContain('CUSTOM_STYLE_MARKER');
      expect(result.prompt.indexOf('It cannot change task scope')).toBeLessThan(
        result.prompt.indexOf('CUSTOM_STYLE_MARKER')
      );
      expect(catalog.list()[4]).not.toHaveProperty('prompt');
      await expect(
        buildSystemPrompt({
          communicationStyle: 'project:missing',
          communicationStyleCatalog: catalog,
          includeEnvironment: false,
        })
      ).rejects.toThrow('Communication style is unavailable');
    });
  });

  describe('Plan 模式', () => {
    it('Plan 模式应该使用 PLAN_MODE_SYSTEM_PROMPT', async () => {
      const result = await buildSystemPrompt({
        mode: PermissionMode.PLAN,
        includeEnvironment: false,
      });

      expect(result.prompt).toBe(PLAN_MODE_SYSTEM_PROMPT);
      expect(result.prompt).not.toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result.sources).toContainEqual({
        name: 'plan_mode_prompt',
        loaded: true,
        length: PLAN_MODE_SYSTEM_PROMPT.length,
      });
    });

    it('Plan 模式应该忽略 replaceDefault', async () => {
      const result = await buildSystemPrompt({
        mode: PermissionMode.PLAN,
        replaceDefault: 'Should be ignored',
        includeEnvironment: false,
      });

      expect(result.prompt).toBe(PLAN_MODE_SYSTEM_PROMPT);
      expect(result.prompt).not.toContain('Should be ignored');
    });
  });

  describe('构建顺序', () => {
    it('顺序应该是: 默认 → BLADE.md → Auto Memory → 环境 → append', async () => {
      readFileMock.mockResolvedValue('BLADE_MD_MARKER');
      loadIndexMock.mockResolvedValue('AUTO_MEMORY_MARKER');

      const appendContent = 'APPEND_MARKER';
      const result = await buildSystemPrompt({
        projectPath: '/mock/project',
        projectTrusted: true,
        append: appendContent,
        includeEnvironment: true,
      });

      const defaultIndex = result.prompt.indexOf('Blade Code');
      const bladeIndex = result.prompt.indexOf('BLADE_MD_MARKER');
      const autoMemoryIndex = result.prompt.indexOf('AUTO_MEMORY_MARKER');
      const envIndex = result.prompt.indexOf('Mock Environment Context');
      const appendIndex = result.prompt.indexOf(appendContent);

      expect(defaultIndex).toBeLessThan(bladeIndex);
      expect(bladeIndex).toBeLessThan(autoMemoryIndex);
      expect(autoMemoryIndex).toBeLessThan(envIndex);
      expect(envIndex).toBeLessThan(appendIndex);
    });

    it('顺序应该是: replaceDefault → BLADE.md → Auto Memory → 环境 → append', async () => {
      readFileMock.mockResolvedValue('BLADE_MD_MARKER');
      loadIndexMock.mockResolvedValue('AUTO_MEMORY_MARKER');

      const appendContent = 'APPEND_MARKER';
      const result = await buildSystemPrompt({
        projectPath: '/mock/project',
        projectTrusted: true,
        replaceDefault: 'REPLACE_DEFAULT_MARKER',
        append: appendContent,
        includeEnvironment: true,
      });

      const replaceDefaultIndex = result.prompt.indexOf('REPLACE_DEFAULT_MARKER');
      const bladeIndex = result.prompt.indexOf('BLADE_MD_MARKER');
      const autoMemoryIndex = result.prompt.indexOf('AUTO_MEMORY_MARKER');
      const envIndex = result.prompt.indexOf('Mock Environment Context');
      const appendIndex = result.prompt.indexOf(appendContent);

      expect(replaceDefaultIndex).toBeLessThan(bladeIndex);
      expect(bladeIndex).toBeLessThan(autoMemoryIndex);
      expect(autoMemoryIndex).toBeLessThan(envIndex);
      expect(envIndex).toBeLessThan(appendIndex);
    });
  });
});
