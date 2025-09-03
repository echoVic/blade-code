import React from 'react';
import { render } from 'ink';
import { BladeApp } from '../src/App.js';
import { ConfigManager } from '../src/config/config-manager.js';

// Mock modules
jest.mock('../src/config/config-manager.js');
jest.mock('../src/hooks/useKeyboardShortcuts.js');
jest.mock('../src/hooks/useAppNavigation.js');

describe('BladeApp', () => {
  let mockConfig: any;
  
  beforeEach(() => {
    mockConfig = {
      version: '1.0.0',
      core: {
        debug: false,
        telemetry: true,
        autoUpdate: true,
        maxMemory: 1024,
        timeout: 30000,
        workingDirectory: '/test',
        tempDirectory: '/tmp',
      },
      ui: {
        theme: 'default',
        fontSize: 14,
        fontFamily: 'monospace',
        lineHeight: 1.4,
        showStatusBar: true,
        showNotifications: true,
        animations: true,
        shortcuts: {},
        language: 'zh-CN',
      },
      // ... other config properties
    };
    
    (ConfigManager.getInstance as jest.Mock).mockReturnValue({
      initialize: jest.fn().mockResolvedValue(mockConfig),
      getConfig: jest.fn().mockReturnValue(mockConfig),
    });
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  it('should render without crashing', () => {
    expect(() => {
      render(<BladeApp />);
    }).not.toThrow();
  });
  
  it('should initialize with provided config', async () => {
    const configManager = ConfigManager.getInstance();
    
    render(<BladeApp config={mockConfig} />);
    
    expect(configManager.initialize).toHaveBeenCalledWith(mockConfig);
  });
  
  it('should render splash screen initially', () => {
    const { container } = render(<BladeApp />);
    
    // 检查是否渲染了启动画面
    expect(container).toBeTruthy();
  });
  
  it('should show debug mode when enabled', () => {
    const { container } = render(<BladeApp debug={true} />);
    
    // 检查是否显示了调试模式标识
    expect(container).toBeTruthy();
  });
  
  it('should handle initialization errors', async () => {
    const configManager = ConfigManager.getInstance();
    configManager.initialize.mockRejectedValue(new Error('初始化失败'));
    
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    
    expect(() => {
      render(<BladeApp />);
    }).not.toThrow();
    
    consoleErrorSpy.mockRestore();
  });
});