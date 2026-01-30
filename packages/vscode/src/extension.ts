/**
 * Blade Code VS Code Extension
 *
 * 提供 VS Code 与 Blade CLI 的双向通信
 */

import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 环境变量名
const ENV_VAR_NAME = 'BLADE_IDE_PORT';

// 端口文件路径 (~/.blade/ide-port)
const PORT_FILE_DIR = path.join(os.homedir(), '.blade');
const PORT_FILE_PATH = path.join(PORT_FILE_DIR, 'ide-port');

// 全局状态
let server: WebSocketServer | null = null;
let serverPort: number | null = null;
let connectedClients: Set<WebSocket> = new Set();
let statusBarItem: vscode.StatusBarItem;

/**
 * 插件激活
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('[Blade Code] Extension activating...');

  // 创建状态栏项
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'blade-code.status';
  context.subscriptions.push(statusBarItem);

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('blade-code.start', startServer),
    vscode.commands.registerCommand('blade-code.stop', stopServer),
    vscode.commands.registerCommand('blade-code.status', showStatus)
  );

  // 自动启动
  const config = vscode.workspace.getConfiguration('bladeCode');
  if (config.get<boolean>('autoStart', true)) {
    startServer();
  }

  updateStatusBar();
  console.log('[Blade Code] Extension activated');
}

/**
 * 插件停用
 */
export function deactivate() {
  console.log('[Blade Code] Extension deactivating...');
  stopServer();
  console.log('[Blade Code] Extension deactivated');
}

/**
 * 启动 WebSocket 服务器
 */
async function startServer() {
  if (server) {
    vscode.window.showInformationMessage(`Blade Code server already running on port ${serverPort}`);
    return;
  }

  const config = vscode.workspace.getConfiguration('bladeCode');
  const configPort = config.get<number>('port', 0);

  try {
    // 创建 WebSocket 服务器
    server = new WebSocketServer({ port: configPort });

    // 获取实际端口
    const address = server.address();
    serverPort = typeof address === 'object' && address ? address.port : configPort;

    console.log(`[Blade Code] Server started on port ${serverPort}`);

    // 设置环境变量（供子进程使用）
    process.env[ENV_VAR_NAME] = String(serverPort);

    // 写入端口文件（供外部终端使用）
    writePortFile(serverPort);

    // 设置终端环境变量
    setTerminalEnv(serverPort);

    // 处理连接
    server.on('connection', handleConnection);

    server.on('error', (error) => {
      console.error('[Blade Code] Server error:', error);
      vscode.window.showErrorMessage(`Blade Code server error: ${error.message}`);
    });

    updateStatusBar();
    vscode.window.showInformationMessage(`Blade Code server started on port ${serverPort}`);
  } catch (error) {
    console.error('[Blade Code] Failed to start server:', error);
    vscode.window.showErrorMessage(`Failed to start Blade Code server: ${error}`);
  }
}

/**
 * 停止服务器
 */
function stopServer() {
  if (!server) {
    return;
  }

  // 关闭所有客户端连接
  for (const client of connectedClients) {
    client.close();
  }
  connectedClients.clear();

  // 关闭服务器
  server.close();
  server = null;
  serverPort = null;

  // 清除环境变量
  delete process.env[ENV_VAR_NAME];

  // 删除端口文件
  removePortFile();

  updateStatusBar();
  console.log('[Blade Code] Server stopped');
}

/**
 * 处理 WebSocket 连接
 */
function handleConnection(ws: WebSocket) {
  console.log('[Blade Code] Client connected');
  connectedClients.add(ws);
  updateStatusBar();

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[Blade Code] Received:', message);

      const response = await handleMessage(message);
      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error('[Blade Code] Error handling message:', error);
      ws.send(JSON.stringify({
        id: null,
        error: { message: String(error) }
      }));
    }
  });

  ws.on('close', () => {
    console.log('[Blade Code] Client disconnected');
    connectedClients.delete(ws);
    updateStatusBar();
  });

  ws.on('error', (error) => {
    console.error('[Blade Code] Client error:', error);
    connectedClients.delete(ws);
    updateStatusBar();
  });
}

/**
 * 处理消息
 */
async function handleMessage(message: any): Promise<any> {
  const { id, method, params } = message;

  try {
    let result: any;

    switch (method) {
      case 'openFile':
        result = await openFile(params.filePath, params.options);
        break;

      case 'getOpenEditors':
        result = await getOpenEditors();
        break;

      case 'getCurrentSelection':
        result = await getCurrentSelection();
        break;

      case 'getWorkspaceFolders':
        result = await getWorkspaceFolders();
        break;

      case 'getDiagnostics':
        result = await getDiagnostics(params?.uri);
        break;

      case 'openDiff':
        result = await openDiff(params);
        break;

      case 'showMessage':
        result = await showMessage(params);
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { id, result };
  } catch (error) {
    return {
      id,
      error: { message: error instanceof Error ? error.message : String(error) }
    };
  }
}

/**
 * 在编辑器中打开文件
 */
async function openFile(filePath: string, options?: { preview?: boolean; line?: number; column?: number }) {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const viewColumn = vscode.ViewColumn.Active;
  const editor = await vscode.window.showTextDocument(doc, {
    preview: options?.preview ?? true,
    viewColumn,
  });

  // 如果指定了行号，跳转到该行
  if (options?.line !== undefined) {
    const position = new vscode.Position(options.line - 1, options.column ?? 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  return {
    success: true,
    filePath: doc.fileName
  };
}

/**
 * 获取打开的编辑器列表
 */
async function getOpenEditors() {
  const editors: Array<{ filePath: string; isActive: boolean }> = [];

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        editors.push({
          filePath: tab.input.uri.fsPath,
          isActive: tab.isActive
        });
      }
    }
  }

  return { editors };
}

/**
 * 获取当前选中的文本
 */
async function getCurrentSelection() {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return { error: 'No active editor' };
  }

  const selection = editor.selection;
  const text = editor.document.getText(selection);

  return {
    filePath: editor.document.fileName,
    text,
    selection: {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character }
    }
  };
}

/**
 * 获取工作区文件夹
 */
async function getWorkspaceFolders() {
  const folders = vscode.workspace.workspaceFolders?.map(folder => ({
    name: folder.name,
    uri: folder.uri.fsPath
  })) || [];

  return { folders };
}

/**
 * 获取诊断信息
 */
async function getDiagnostics(uri?: string) {
  let diagnostics: Array<{ uri: string; diagnostics: any[] }> = [];

  if (uri) {
    const targetUri = vscode.Uri.file(uri);
    const diags = vscode.languages.getDiagnostics(targetUri);
    diagnostics.push({
      uri,
      diagnostics: diags.map(formatDiagnostic)
    });
  } else {
    // 获取所有诊断
    const allDiags = vscode.languages.getDiagnostics();
    for (const [docUri, diags] of allDiags) {
      if (diags.length > 0) {
        diagnostics.push({
          uri: docUri.fsPath,
          diagnostics: diags.map(formatDiagnostic)
        });
      }
    }
  }

  return { diagnostics };
}

/**
 * 格式化诊断信息
 */
function formatDiagnostic(diag: vscode.Diagnostic) {
  return {
    message: diag.message,
    severity: vscode.DiagnosticSeverity[diag.severity],
    range: {
      start: { line: diag.range.start.line, character: diag.range.start.character },
      end: { line: diag.range.end.line, character: diag.range.end.character }
    },
    source: diag.source,
    code: diag.code
  };
}

/**
 * 打开 diff 视图
 */
async function openDiff(params: { originalPath: string; modifiedPath: string; title?: string }) {
  const originalUri = vscode.Uri.file(params.originalPath);
  const modifiedUri = vscode.Uri.file(params.modifiedPath);

  await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, params.title || 'Diff');

  return { success: true };
}

/**
 * 显示消息
 */
async function showMessage(params: { type: 'info' | 'warning' | 'error'; message: string }) {
  switch (params.type) {
    case 'info':
      vscode.window.showInformationMessage(params.message);
      break;
    case 'warning':
      vscode.window.showWarningMessage(params.message);
      break;
    case 'error':
      vscode.window.showErrorMessage(params.message);
      break;
  }

  return { success: true };
}

/**
 * 写入端口文件
 */
function writePortFile(port: number) {
  try {
    // 确保目录存在
    if (!fs.existsSync(PORT_FILE_DIR)) {
      fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
    }

    // 写入端口信息（JSON 格式，包含更多元数据）
    const portInfo = {
      port,
      pid: process.pid,
      startTime: Date.now(),
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
    };

    fs.writeFileSync(PORT_FILE_PATH, JSON.stringify(portInfo, null, 2));
    console.log(`[Blade Code] Port file written to ${PORT_FILE_PATH}`);
  } catch (error) {
    console.error('[Blade Code] Failed to write port file:', error);
  }
}

/**
 * 删除端口文件
 */
function removePortFile() {
  try {
    if (fs.existsSync(PORT_FILE_PATH)) {
      fs.unlinkSync(PORT_FILE_PATH);
      console.log('[Blade Code] Port file removed');
    }
  } catch (error) {
    console.error('[Blade Code] Failed to remove port file:', error);
  }
}

/**
 * 设置终端环境变量
 */
function setTerminalEnv(port: number) {
  // 为所有新终端设置环境变量
  const terminalOptions: vscode.ExtensionTerminalOptions = {
    name: 'Blade Code',
    env: { [ENV_VAR_NAME]: String(port) }
  };

  // 使用 VS Code API 更新终端环境变量
  // 注意：这只影响新创建的终端
  vscode.workspace.getConfiguration().update(
    'terminal.integrated.env.linux',
    { ...vscode.workspace.getConfiguration().get('terminal.integrated.env.linux'), [ENV_VAR_NAME]: String(port) },
    vscode.ConfigurationTarget.Workspace
  );
  vscode.workspace.getConfiguration().update(
    'terminal.integrated.env.osx',
    { ...vscode.workspace.getConfiguration().get('terminal.integrated.env.osx'), [ENV_VAR_NAME]: String(port) },
    vscode.ConfigurationTarget.Workspace
  );
  vscode.workspace.getConfiguration().update(
    'terminal.integrated.env.windows',
    { ...vscode.workspace.getConfiguration().get('terminal.integrated.env.windows'), [ENV_VAR_NAME]: String(port) },
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * 更新状态栏
 */
function updateStatusBar() {
  if (server && serverPort) {
    const clientCount = connectedClients.size;
    statusBarItem.text = `$(plug) Blade: ${serverPort} (${clientCount})`;
    statusBarItem.tooltip = `Blade Code server running on port ${serverPort}\n${clientCount} client(s) connected`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(plug) Blade: Off';
    statusBarItem.tooltip = 'Blade Code server is not running';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

/**
 * 显示状态
 */
async function showStatus() {
  const items: string[] = [];

  if (server && serverPort) {
    items.push(`Server: Running on port ${serverPort}`);
    items.push(`Connected clients: ${connectedClients.size}`);
    items.push(`Environment variable: ${ENV_VAR_NAME}=${serverPort}`);
  } else {
    items.push('Server: Not running');
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    items.push(`Workspace: ${workspaceFolders.map(f => f.name).join(', ')}`);
  }

  vscode.window.showInformationMessage(items.join('\n'), { modal: true });
}
