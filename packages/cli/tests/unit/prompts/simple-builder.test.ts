import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types';
import { buildSystemPrompt } from '../../../src/prompts/builder';
import {
  DEFAULT_SYSTEM_PROMPT,
  PLAN_MODE_SYSTEM_PROMPT,
} from '../../../src/prompts/default';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      access: vi.fn(),
    },
  };
});

// Mock environment
vi.mock('../../../src/utils/environment.js', () => ({
  getEnvironmentContext: vi.fn().mockReturnValue('Mock Environment Context'),
}));

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('基础功能', () => {
    it('应该返回默认提示词（不含环境上下文）', async () => {
      const result = await buildSystemPrompt({ includeEnvironment: false });

      expect(result.prompt).toContain('You are Blade Code');
      expect(result.sources).toContainEqual({
        name: 'default',
        loaded: true,
        length: expect.any(Number),
      });
    });

    it('应该包含环境上下文（默认）', async () => {
      const result = await buildSystemPrompt();

      expect(result.prompt).toContain('Mock Environment Context');
      expect(result.prompt).toContain('You are Blade Code');
      expect(result.sources).toContainEqual({
        name: 'environment',
        loaded: true,
        length: expect.any(Number),
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
    it('顺序应该是: 环境 → 默认 → append', async () => {
      const appendContent = 'APPEND_MARKER';
      const result = await buildSystemPrompt({
        append: appendContent,
        includeEnvironment: true,
      });

      const envIndex = result.prompt.indexOf('Mock Environment Context');
      const defaultIndex = result.prompt.indexOf('Blade Code');
      const appendIndex = result.prompt.indexOf(appendContent);

      expect(envIndex).toBeLessThan(defaultIndex);
      expect(defaultIndex).toBeLessThan(appendIndex);
    });
  });
});
