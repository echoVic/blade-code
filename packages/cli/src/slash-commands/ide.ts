/**
 * /ide 斜杠命令 - 管理 IDE 集成
 *
 * 子命令：
 * - /ide          显示 IDE 连接状态
 * - /ide status   显示详细状态和打开的文件
 * - /ide connect  连接到 IDE
 * - /ide install  安装 VS Code 插件
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IdeDetector } from '../ide/detectIde.js';
import { IdeInstaller } from '../ide/ideInstaller.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

// 端口文件路径
const PORT_FILE_PATH = join(homedir(), '.blade', 'ide-port');

interface PortFileInfo {
  port: number;
  pid: number;
  startTime: number;
  workspaceFolders: string[];
}

enum IdeConnectionStatus {
  Connected = 'connected',
  Connecting = 'connecting',
  Disconnected = 'disconnected',
}

// 全局 IDE 状态
let ideConnectionStatus = IdeConnectionStatus.Disconnected;
let connectedIdeName: string | null = null;
let idePort: number | null = null;

/**
 * 获取 IDE 连接状态消息
 */
function getStatusMessage(): { type: 'info' | 'error'; content: string } {
  switch (ideConnectionStatus) {
    case IdeConnectionStatus.Connected:
      return {
        type: 'info',
        content: `🟢 已连接到 ${connectedIdeName || 'IDE'} (端口: ${idePort})`,
      };
    case IdeConnectionStatus.Connecting:
      return {
        type: 'info',
        content: '🟡 正在连接...',
      };
    default:
      return {
        type: 'error',
        content: '🔴 未连接到 IDE',
      };
  }
}

/**
 * 从端口文件读取信息
 */
function readPortFile(): PortFileInfo | null {
  try {
    if (existsSync(PORT_FILE_PATH)) {
      const content = readFileSync(PORT_FILE_PATH, 'utf-8');
      return JSON.parse(content) as PortFileInfo;
    }
  } catch {
    // 忽略读取错误
  }
  return null;
}

/**
 * 检测端口
 */
function detectIdePort(): number | null {
  // 优先从环境变量读取
  const envPort = process.env.BLADE_IDE_PORT;
  if (envPort) {
    return parseInt(envPort, 10);
  }

  // 从端口文件读取
  const portInfo = readPortFile();
  if (portInfo) {
    return portInfo.port;
  }

  return null;
}

/**
 * 处理 status 子命令
 */
async function handleStatus(): Promise<string> {
  const lines: string[] = [];

  // 1. 连接状态
  const status = getStatusMessage();
  lines.push(status.content);
  lines.push('');

  // 2. 检测已安装的 IDE
  lines.push('📦 已安装的 IDE:');
  const installedIdes = await IdeInstaller.getInstalledIdes();

  if (installedIdes.length === 0) {
    lines.push('  (未检测到支持的 IDE)');
  } else {
    for (const ide of installedIdes) {
      lines.push(`  • ${ide.name} ${ide.version}`);
    }
  }
  lines.push('');

  // 3. 检测当前环境
  const currentIde = await IdeDetector.detectIde();
  if (currentIde) {
    lines.push(`🖥️  当前环境: ${currentIde.name} ${currentIde.version}`);

    // 显示已安装的扩展数量
    if (currentIde.extensions.length > 0) {
      lines.push(`   已安装扩展: ${currentIde.extensions.length} 个`);
    }
  }

  // 4. 端口信息
  const port = detectIdePort();
  const portInfo = readPortFile();
  if (port) {
    lines.push(`🔌 IDE 端口: ${port}`);
    if (portInfo && portInfo.workspaceFolders.length > 0) {
      lines.push(`   工作区: ${portInfo.workspaceFolders[0]}`);
    }
  } else {
    lines.push('');
    lines.push('💡 提示: 在 VS Code 中安装 Blade Code 插件后，运行 /ide connect 连接');
  }

  return lines.join('\n');
}

/**
 * 处理 connect 子命令
 */
async function handleConnect(): Promise<string> {
  const port = detectIdePort();

  if (!port) {
    return `❌ 未检测到 IDE 端口

请确保:
1. 已在 VS Code 中安装 Blade Code 插件
2. 插件已启动 (查看 VS Code 输出面板)
3. 在 VS Code 终端中运行 blade

或手动设置端口:
  export BLADE_IDE_PORT=9527`;
  }

  ideConnectionStatus = IdeConnectionStatus.Connecting;

  try {
    // 尝试连接
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('连接超时'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        ideConnectionStatus = IdeConnectionStatus.Connected;
        idePort = port;
        connectedIdeName = 'VS Code';
        ws.close(); // 测试连接后关闭
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return `✅ 成功连接到 IDE (端口: ${port})

现在可以使用以下功能:
  • 在 IDE 中打开文件
  • 获取当前选中的代码
  • 查看打开的编辑器列表`;
  } catch (error) {
    ideConnectionStatus = IdeConnectionStatus.Disconnected;
    return `❌ 连接失败: ${error instanceof Error ? error.message : '未知错误'}

请检查:
1. VS Code 插件是否正在运行
2. 端口 ${port} 是否正确
3. 防火墙设置`;
  }
}

/**
 * 处理 install 子命令
 */
async function handleInstall(): Promise<string> {
  const lines: string[] = [];

  lines.push('📦 安装 Blade Code VS Code 插件');
  lines.push('');

  // 检测 VS Code
  const isVsCodeInstalled = await IdeInstaller.isIdeInstalled('vscode');

  if (!isVsCodeInstalled) {
    lines.push('❌ 未检测到 VS Code');
    lines.push('');
    lines.push('请先安装 VS Code:');
    lines.push('  https://code.visualstudio.com/');
    return lines.join('\n');
  }

  lines.push('✅ 检测到 VS Code');
  lines.push('');

  // 提供安装方式
  lines.push('安装方式:');
  lines.push('');
  lines.push('从 VSIX 文件安装:');
  lines.push('  1. 下载插件: https://github.com/anthropics/blade-code/releases');
  lines.push('  2. 运行: code --install-extension blade-code-x.x.x.vsix');
  lines.push('');
  lines.push('或从源码构建:');
  lines.push('  cd packages/vscode && bun install && bun run package');
  lines.push('  code --install-extension blade-code-0.0.1.vsix');
  lines.push('');
  lines.push('安装完成后，在 VS Code 终端中运行 blade 即可自动连接');

  return lines.join('\n');
}

/**
 * 处理 disconnect 子命令
 */
async function handleDisconnect(): Promise<string> {
  if (ideConnectionStatus === IdeConnectionStatus.Disconnected) {
    return '⚠️ 当前未连接到任何 IDE';
  }

  ideConnectionStatus = IdeConnectionStatus.Disconnected;
  connectedIdeName = null;
  idePort = null;

  return '✅ 已断开与 IDE 的连接';
}

const ideCommand: SlashCommand = {
  name: 'ide',
  aliases: [],
  description: 'Manage IDE integrations and show status',
  usage: '/ide [status|connect|install|disconnect]',
  category: 'system',

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const subCommand = (args[0] || '').toLowerCase();

    let message: string;

    switch (subCommand) {
      case '':
      case 'status':
        message = await handleStatus();
        break;
      case 'connect':
        message = await handleConnect();
        break;
      case 'install':
        message = await handleInstall();
        break;
      case 'disconnect':
        message = await handleDisconnect();
        break;
      default:
        message = `未知的子命令: ${subCommand}

可用命令:
  /ide status     - 显示连接状态
  /ide connect    - 连接到 IDE
  /ide install    - 安装 VS Code 插件
  /ide disconnect - 断开连接`;
    }

    return {
      success: true,
      message,
    };
  },
};

export default ideCommand;
