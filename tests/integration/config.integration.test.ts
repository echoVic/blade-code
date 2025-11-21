import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
    process.env.BLADE_API_KEY = 'env-key';
    process.env.BLADE_THEME = 'light';

    const userConfigPath = path.join(tempHome, '.blade', 'config.json');
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      JSON.stringify(
        {
          apiKey: '${BLADE_API_KEY}',
          theme: '${BLADE_THEME:-GitHub}',
        },
        null,
        2
      ),
      'utf-8'
    );

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize();

    expect(config.apiKey).toBe('env-key');
    expect(config.theme).toBe('light');

    await manager.updateConfig({ theme: 'dark', language: 'zh-CN' });

    ConfigManager.resetInstance();
    const reloaded = ConfigManager.getInstance();
    const persisted = await reloaded.initialize();

    expect(persisted.theme).toBe('dark');
    expect(persisted.language).toBe('zh-CN');
  });

  it('项目级配置应覆盖用户配置', async () => {
    const userConfigPath = path.join(tempHome, '.blade', 'config.json');
    const projectConfigPath = path.join(tempProject, '.blade', 'config.json');

    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      JSON.stringify({ model: 'user-model', baseUrl: 'https://user.example.com' }),
      { encoding: 'utf-8', flag: 'w+' }
    );
    mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    writeFileSync(projectConfigPath, JSON.stringify({ model: 'project-model' }), {
      encoding: 'utf-8',
      flag: 'w+',
    });

    const manager = ConfigManager.getInstance();
    const config = await manager.initialize();

    expect(config.model).toBe('project-model');
    expect(config.baseUrl).toBe('https://user.example.com');
  });

  it('应维护 settings.local.json 并忽略重复记录', async () => {
    const manager = ConfigManager.getInstance();
    await manager.initialize();

    await manager.appendPermissionAllowRule('Read(file_path:package.json)');
    await manager.appendPermissionAllowRule('Read(file_path:package.json)');

    const settingsPath = path.join(tempHome, '.blade', 'settings.json');
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(written.permissions.allow).toEqual(['Read(file_path:package.json)']);
  });
});
