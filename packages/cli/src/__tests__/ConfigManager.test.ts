import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../src/config/config-manager.js';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
    unlink: jest.fn(),
  },
}));

// Mock os module
jest.mock('os', () => ({
  homedir: jest.fn(),
  tmpdir: jest.fn(),
}));

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let mockHomedir: string;
  let mockTmpdir: string;
  
  beforeEach(() => {
    mockHomedir = '/mock/home';
    mockTmpdir = '/mock/tmp';
    
    (os.homedir as jest.Mock).mockReturnValue(mockHomedir);
    (os.tmpdir as jest.Mock).mockReturnValue(mockTmpdir);
    
    // 重置模块缓存以获取新的单例实例
    jest.resetModules();
    configManager = ConfigManager.getInstance();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  it('should be a singleton', () => {
    const instance1 = ConfigManager.getInstance();
    const instance2 = ConfigManager.getInstance();
    
    expect(instance1).toBe(instance2);
  });
  
  it('should initialize with default config', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
          name: 'blade-ai',
          description: '测试描述',
        }));
      }
      throw new Error('File not found');
    });
    
    const config = await configManager.initialize();
    
    expect(config).toBeDefined();
    expect(config.version).toBe('1.0.0');
    expect(config.name).toBe('blade-ai');
  });
  
  it('should merge user config with default config', async () => {
    (fs.readFile as jest.Mock)
      .mockImplementationOnce((filePath: string) => {
        if (filePath.includes('package.json')) {
          return Promise.resolve(JSON.stringify({
            version: '1.0.0',
          }));
        }
        throw new Error('File not found');
      })
      .mockImplementationOnce((filePath: string) => {
        if (filePath.includes('.blade/config.json')) {
          return Promise.resolve(JSON.stringify({
            ui: {
              theme: 'dark',
            },
          }));
        }
        throw new Error('File not found');
      });
    
    const config = await configManager.initialize();
    
    expect(config.ui.theme).toBe('dark');
  });
  
  it('should apply environment variables', async () => {
    process.env.BLADE_DEBUG = 'true';
    process.env.BLADE_THEME = 'highContrast';
    
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
        }));
      }
      throw new Error('File not found');
    });
    
    const config = await configManager.initialize();
    
    expect(config.core.debug).toBe(true);
    expect(config.ui.theme).toBe('highContrast');
    
    // 清理环境变量
    delete process.env.BLADE_DEBUG;
    delete process.env.BLADE_THEME;
  });
  
  it('should validate config and return status', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
        }));
      }
      throw new Error('File not found');
    });
    
    await configManager.initialize();
    const status = configManager.getConfigStatus();
    
    expect(status.isValid).toBe(true);
    expect(status.errors).toHaveLength(0);
  });
  
  it('should handle config validation errors', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({}));
      }
      throw new Error('File not found');
    });
    
    await configManager.initialize();
    const status = configManager.getConfigStatus();
    
    expect(status.isValid).toBe(false);
    expect(status.errors.length).toBeGreaterThan(0);
  });
  
  it('should update config and save to file', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
        }));
      }
      throw new Error('File not found');
    });
    
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    
    await configManager.initialize();
    
    const status = await configManager.updateConfig({
      ui: {
        theme: 'dark',
      },
    });
    
    expect(status.isValid).toBe(true);
    expect(fs.writeFile).toHaveBeenCalled();
  });
  
  it('should reset config to defaults', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
        }));
      }
      throw new Error('File not found');
    });
    
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    
    const config = await configManager.resetConfig();
    
    expect(config).toBeDefined();
    expect(fs.unlink).toHaveBeenCalled();
  });
  
  it('should export and import config', async () => {
    (fs.readFile as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('package.json')) {
        return Promise.resolve(JSON.stringify({
          version: '1.0.0',
        }));
      }
      throw new Error('File not found');
    });
    
    await configManager.initialize();
    
    const exportedConfig = configManager.exportConfig();
    expect(exportedConfig).toContain('version');
    
    const status = await configManager.importConfig(exportedConfig);
    expect(status.isValid).toBe(true);
  });
});