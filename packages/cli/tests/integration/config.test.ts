import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../src/config/ConfigManager.js';

describe('ConfigManager 集成', () => {
  let tempHome: string;
  let tempProject: string;
  let originalCwd: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ConfigManager.resetInstance();

    tempHome = mkdtempSync(path.join(os.tmpdir(), 'blade-home-'));
    tempProject = mkdtempSync(path.join(os.tmpdir(), 'blade-project-'));
    originalCwd = process.cwd();
    process.chdir(tempProject);

    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    homedirSpy.mockRestore();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempProject, { recursive: true, force: true });
    delete process.env.BLADE_API_KEY;
    delete process.env.BLADE_THEME;
    ConfigManager.resetInstance();
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
});
