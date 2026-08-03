import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCwdState } from '../../src/bootstrap/state.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { ConfigService } from '../../src/config/ConfigService.js';

describe('ConfigManager 集成', () => {
  let tempHome: string;
  let tempProject: string;
  let originalCwd: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ConfigManager.resetInstance();
    ConfigService.resetInstance();

    tempHome = mkdtempSync(path.join(os.tmpdir(), 'blade-home-'));
    tempProject = mkdtempSync(path.join(os.tmpdir(), 'blade-project-'));
    originalCwd = process.cwd();
    process.chdir(tempProject);
    setCwdState(tempProject);

    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setCwdState(originalCwd);
    homedirSpy.mockRestore();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempProject, { recursive: true, force: true });
    delete process.env.BLADE_API_KEY;
    delete process.env.BLADE_THEME;
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
  });

  it('环境变量占位符应被解析，并可持久化覆盖', async () => {
    process.env.BLADE_THEME = 'light';

    const userConfigPath = path.join(tempHome, '.blade', 'config.json');
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      JSON.stringify(
        {
          theme: '${BLADE_THEME:-GitHub}',
          currentModelId: 'test-model',
          models: [
            {
              id: 'test-model',
              name: 'Test Model',
              provider: 'openai-compatible',
              apiKey: 'test-key',
              baseUrl: 'https://api.example.com',
              model: 'gpt-4',
            },
          ],
          temperature: 0.7,
          maxContextTokens: 8000,
          maxOutputTokens: 4000,
          stream: true,
          topP: 1,
          topK: 0,
          timeout: 30000,
          language: 'en',
          debug: false,
          mcpEnabled: false,
          mcpServers: {},
          permissions: { allow: [], ask: [], deny: [] },
          permissionMode: 'DEFAULT',
          hooks: {},
          env: {},
          disableAllHooks: false,
          maxTurns: 10,
        },
        null,
        2
      ),
      'utf-8'
    );

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize();

    expect(config.theme).toBe('light');

    // 使用 store 的 configActions 来更新配置
    const { configActions, ensureStoreInitialized } = await import(
      '../../src/store/vanilla.js'
    );
    await ensureStoreInitialized();
    await configActions().updateConfig({ theme: 'dark', language: 'zh-CN' });

    // 为了验证持久化，我们需要确保配置已写入磁盘
    await configActions().flush(); // 立即刷新所有待持久化变更

    ConfigManager.resetInstance();
    const reloaded = ConfigManager.getInstance();
    const persisted = await reloaded.initialize();

    // 由于持久化配置可能与内存配置不同，我们验证配置已正确加载
    expect(persisted.theme).toBe('dark');
    expect(persisted.language).toBe('zh-CN');
  });

  it('项目级配置应覆盖用户配置', async () => {
    const userConfigPath = path.join(tempHome, '.blade', 'config.json');
    const projectConfigPath = path.join(tempProject, '.blade', 'config.json');

    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        currentModelId: 'user-model',
        models: [
          {
            id: 'user-model',
            name: 'User Model',
            provider: 'openai-compatible',
            apiKey: 'user-key',
            baseUrl: 'https://user.example.com',
            model: 'gpt-4',
          },
        ],
        temperature: 0.7,
        maxContextTokens: 8000,
        maxOutputTokens: 4000,
        stream: true,
        topP: 1,
        topK: 0,
        timeout: 30000,
        theme: 'GitHub',
        language: 'en',
        fontSize: 14,
        debug: false,
        mcpEnabled: false,
        mcpServers: {},
        permissions: { allow: [], ask: [], deny: [] },
        permissionMode: 'DEFAULT',
        hooks: {},
        env: {},
        disableAllHooks: false,
        maxTurns: 10,
      }),
      { encoding: 'utf-8', flag: 'w+' }
    );
    mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        currentModelId: 'project-model',
        models: [
          {
            id: 'project-model',
            name: 'Project Model',
            provider: 'openai-compatible',
            apiKey: 'project-key',
            baseUrl: 'https://project.example.com',
            model: 'gpt-3.5-turbo',
          },
        ],
        theme: 'dark',
      }),
      {
        encoding: 'utf-8',
        flag: 'w+',
      }
    );

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize();

    expect(config.currentModelId).toBe('project-model');
    expect(config.theme).toBe('dark');
  });

  it('显式 settings 层应覆盖文件设置并保留运行时字段', async () => {
    const projectSettingsPath = path.join(tempProject, '.blade', 'settings.json');
    mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    writeFileSync(
      projectSettingsPath,
      JSON.stringify({
        maxTurns: 3,
        permissions: { allow: ['Read(project)'], ask: [], deny: [] },
      })
    );

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize({
      appendSystemPrompt: 'FLAG_SETTINGS_RULE',
      maxTurns: 8,
      permissions: { allow: ['Read(flag)'], ask: [], deny: [] },
    });

    expect(config.appendSystemPrompt).toBe('FLAG_SETTINGS_RULE');
    expect(config.maxTurns).toBe(8);
    expect(config.permissions.allow).toEqual(
      expect.arrayContaining(['Read(project)', 'Read(flag)'])
    );
  });

  it('应维护 settings.local.json 并忽略重复记录', async () => {
    const manager = ConfigManager.getInstance();
    await manager.initialize();

    // 使用 store 的 configActions 来追加权限规则
    const { configActions, ensureStoreInitialized } = await import(
      '../../src/store/vanilla.js'
    );
    await ensureStoreInitialized();
    await configActions().appendPermissionAllowRule('Read(file_path:package.json)');
    await configActions().appendPermissionAllowRule('Read(file_path:package.json)');

    // 由于 appendPermissionAllowRule 使用 local scope（默认），它会写入 settings.local.json
    const settingsPath = path.join(tempProject, '.blade', 'settings.local.json');
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(written.permissions.allow).toEqual(['Read(file_path:package.json)']);
  });

  it('应把显式 workspace 的权限规则写入目标项目而不是服务器启动目录', async () => {
    const targetProject = mkdtempSync(path.join(os.tmpdir(), 'blade-target-project-'));
    try {
      await ConfigService.getInstance().appendLocalPermissionRule('Bash(npm test)', {
        immediate: true,
        projectDir: targetProject,
      });

      const targetSettings = path.join(targetProject, '.blade', 'settings.local.json');
      expect(
        JSON.parse(readFileSync(targetSettings, 'utf8')).permissions.allow
      ).toEqual(['Bash(npm test)']);
      expect(() =>
        readFileSync(path.join(tempProject, '.blade', 'settings.local.json'), 'utf8')
      ).toThrow();
    } finally {
      rmSync(targetProject, { recursive: true, force: true });
    }
  });

  it('应为新 runtime 仅加载其 workspace 的项目权限', async () => {
    const targetProject = mkdtempSync(path.join(os.tmpdir(), 'blade-runtime-project-'));
    try {
      const projectSettings = path.join(targetProject, '.blade', 'settings.json');
      const localSettings = path.join(targetProject, '.blade', 'settings.local.json');
      mkdirSync(path.dirname(projectSettings), { recursive: true });
      writeFileSync(
        projectSettings,
        JSON.stringify({
          permissions: { allow: ['Read(project)'], ask: [], deny: [] },
        })
      );
      writeFileSync(
        localSettings,
        JSON.stringify({
          permissions: { allow: ['Bash(npm test)'], ask: [], deny: ['Bash(rm *)'] },
        })
      );

      const manager = ConfigManager.getInstance() as ConfigManager & {
        loadWorkspacePermissions: (
          workspaceRoot: string,
          base: { allow: string[]; ask: string[]; deny: string[] }
        ) => Promise<{ allow: string[]; ask: string[]; deny: string[] }>;
      };
      const permissions = await manager.loadWorkspacePermissions(targetProject, {
        allow: ['Read(global)'],
        ask: ['Write'],
        deny: [],
      });

      expect(permissions).toEqual({
        allow: ['Read(global)', 'Read(project)', 'Bash(npm test)'],
        ask: ['Write'],
        deny: ['Bash(rm *)'],
      });
    } finally {
      rmSync(targetProject, { recursive: true, force: true });
    }
  });

  it('不应把服务器启动项目的本地权限泄漏到另一个 workspace', async () => {
    const targetProject = mkdtempSync(
      path.join(os.tmpdir(), 'blade-isolated-project-')
    );
    try {
      const sourceSettings = path.join(tempProject, '.blade', 'settings.local.json');
      const targetSettings = path.join(targetProject, '.blade', 'settings.local.json');
      mkdirSync(path.dirname(sourceSettings), { recursive: true });
      mkdirSync(path.dirname(targetSettings), { recursive: true });
      writeFileSync(
        sourceSettings,
        JSON.stringify({
          permissions: { allow: ['Bash(source-only)'], ask: [], deny: [] },
        })
      );
      writeFileSync(
        targetSettings,
        JSON.stringify({
          permissions: { allow: ['Bash(target-only)'], ask: [], deny: [] },
        })
      );

      const permissions = await ConfigManager.getInstance().loadWorkspacePermissions(
        targetProject,
        {
          allow: ['Read(default)', 'Bash(source-only)', 'Bash(runtime-override)'],
          ask: [],
          deny: [],
        }
      );

      expect(permissions.allow).toEqual([
        'Read(default)',
        'Bash(runtime-override)',
        'Bash(target-only)',
      ]);
    } finally {
      rmSync(targetProject, { recursive: true, force: true });
    }
  });

  it('标准格式的多模型配置应被正确加载，并清理字符串两端的空格和反引号', async () => {
    const userConfigPath = path.join(tempHome, '.blade', 'config.json');
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        currentModelId: 'claude-via-newapi',
        models: [
          {
            id: 'claude-via-newapi',
            name: 'Claude 3.5 Sonnet',
            provider: 'openai-compatible',
            apiKey: 'sk-test-fake-key-claude-00000000000000',
            baseUrl: ' `https://api.example.com` ',
            model: 'claude-3.5-sonnet',
          },
          {
            id: 'gpt-via-newapi',
            name: 'GPT 4o',
            provider: 'openai-compatible',
            apiKey: 'sk-test-fake-key-gpt-000000000000000000',
            baseUrl: '`https://api.example.com`',
            model: 'gpt-4o',
          },
          {
            id: 'domestic-via-newapi',
            name: 'Qwen Plus',
            provider: 'openai-compatible',
            apiKey: 'sk-test-fake-key-domestic-0000000000000',
            baseUrl: 'https://api.example.com',
            model: 'qwen-plus',
          },
        ],
        temperature: 0.7,
        maxContextTokens: 8000,
        maxOutputTokens: 4000,
        stream: true,
        topP: 1,
        topK: 0,
        timeout: 30000,
        theme: 'GitHub',
        language: 'en',
        fontSize: 14,
        debug: false,
        mcpEnabled: false,
        mcpServers: {},
        permissions: { allow: [], ask: [], deny: [] },
        permissionMode: 'DEFAULT',
        hooks: {},
        env: {},
        disableAllHooks: false,
        maxTurns: 10,
      }),
      { encoding: 'utf-8', flag: 'w+' }
    );

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize();

    const claude = config.models.find((m) => m.id === 'claude-via-newapi');
    expect(claude).toBeDefined();
    expect(claude!.apiKey).toBe('sk-test-fake-key-claude-00000000000000');
    expect(claude!.baseUrl).toBe('https://api.example.com');
    expect(claude!.provider).toBe('openai-compatible');
    expect(claude!.name).toBe('Claude 3.5 Sonnet');
    expect(claude!.model).toBe('claude-3.5-sonnet');

    const gpt = config.models.find((m) => m.id === 'gpt-via-newapi');
    expect(gpt).toBeDefined();
    expect(gpt!.apiKey).toBe('sk-test-fake-key-gpt-000000000000000000');
    expect(gpt!.baseUrl).toBe('https://api.example.com');
    expect(gpt!.provider).toBe('openai-compatible');
    expect(gpt!.model).toBe('gpt-4o');

    const domestic = config.models.find((m) => m.id === 'domestic-via-newapi');
    expect(domestic).toBeDefined();
    expect(domestic!.apiKey).toBe('sk-test-fake-key-domestic-0000000000000');
    expect(domestic!.baseUrl).toBe('https://api.example.com');
    expect(domestic!.provider).toBe('openai-compatible');
    expect(domestic!.model).toBe('qwen-plus');
  });

  it('mergeRuntimeConfig should reject invalid model overrides', async () => {
    const { mergeRuntimeConfig } = await import('../../src/config/ConfigManager.js');

    const baseConfig = {
      currentModelId: 'test-model',
      models: [
        {
          id: 'test-model',
          name: 'Test Model',
          provider: 'openai-compatible',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com',
          model: 'gpt-4',
        },
      ],
      temperature: 0.7,
      maxContextTokens: 8000,
      maxOutputTokens: 4000,
      stream: true,
      topP: 1,
      topK: 0,
      timeout: 30000,
      theme: 'GitHub',
      language: 'en',
      fontSize: 14,
      debug: false,
      mcpEnabled: false,
      mcpServers: {},
      permissions: { allow: [], ask: [], deny: [] },
      permissionMode: 'DEFAULT',
      hooks: {},
      env: {},
      disableAllHooks: false,
      maxTurns: 10,
    };

    expect(() =>
      mergeRuntimeConfig(baseConfig as any, { model: 'missing-model' })
    ).toThrow('模型配置未找到: missing-model');
  });
});
