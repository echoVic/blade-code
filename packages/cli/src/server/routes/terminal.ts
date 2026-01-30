import { Hono } from 'hono';
import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.SERVICE);

// Common PTY interface that works with both bun-pty and node-pty
interface IPtyProcess {
  pid: number;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: { exitCode: number }) => void): void;
}

interface TerminalSession {
  id: string;
  process: IPtyProcess;
  cwd: string;
  buffer: string;
  subscribers: Set<{ send: (data: string) => void; close: () => void }>;
}

const terminals = new Map<string, TerminalSession>();
const BUFFER_LIMIT = 1024 * 1024 * 2;
const BUFFER_CHUNK = 64 * 1024;

type Variables = {
  directory: string;
};

function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

// Spawn PTY process - works with both bun-pty and node-pty
async function spawnPty(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> }
): Promise<IPtyProcess> {
  if (isBunRuntime()) {
    // Use bun-pty in Bun runtime
    // @ts-expect-error bun-pty is only available in Bun runtime
    const { spawn } = await import('bun-pty');
    const ptyProcess = spawn(command, args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      env: options.env,
    });
    return {
      pid: ptyProcess.pid,
      write: (data: string) => ptyProcess.write(data),
      resize: (cols: number, rows: number) => ptyProcess.resize({ cols, rows }),
      kill: () => ptyProcess.kill(),
      onData: (callback: (data: string) => void) => ptyProcess.onData(callback),
      onExit: (callback: (exitInfo: { exitCode: number }) => void) => ptyProcess.onExit(callback),
    };
  }
  // Use node-pty in Node.js runtime
  const nodePty = await import('node-pty');
  const ptyProcess = nodePty.spawn(command, args, {
    name: 'xterm-256color',
    cwd: options.cwd,
    env: options.env,
    cols: 80,
    rows: 24,
  });
  return {
    pid: ptyProcess.pid,
    write: (data: string) => ptyProcess.write(data),
    resize: (cols: number, rows: number) => ptyProcess.resize(cols, rows),
    kill: () => ptyProcess.kill(),
    onData: (callback: (data: string) => void) => {
      ptyProcess.onData(callback);
    },
    onExit: (callback: (exitInfo: { exitCode: number }) => void) => {
      ptyProcess.onExit(callback);
    },
  };
}

// Export websocket handler for Bun server - will be undefined in Node.js
export let terminalWebSocket: unknown = undefined;

// Initialize Bun WebSocket support if in Bun runtime
let upgradeWebSocket: ReturnType<typeof import('hono/bun').createBunWebSocket>['upgradeWebSocket'] | undefined;

if (isBunRuntime()) {
  try {
    const { createBunWebSocket } = await import('hono/bun');
    const bunWs = createBunWebSocket();
    upgradeWebSocket = bunWs.upgradeWebSocket;
    terminalWebSocket = bunWs.websocket;
  } catch (err) {
    logger.warn('[Terminal] Failed to initialize Bun WebSocket support:', err);
  }
}

// Create terminal session handler (shared between Bun and Node.js)
async function handleTerminalConnection(
  cwd: string,
  ws: { send: (data: string) => void; close: () => void }
): Promise<{
  session: TerminalSession;
  cleanup: () => void;
}> {
  const terminalId = `term-${Date.now()}`;
  logger.info(`[Terminal] New connection: ${terminalId}, cwd: ${cwd}`);

  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || '/bin/zsh';
  const shellArgs = shell.endsWith('sh') ? ['-l'] : [];

  const ptyProcess = await spawnPty(shell, shellArgs, {
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  });

  const session: TerminalSession = {
    id: terminalId,
    process: ptyProcess,
    cwd,
    buffer: '',
    subscribers: new Set(),
  };

  terminals.set(terminalId, session);
  session.subscribers.add(ws);

  ptyProcess.onData((data: string) => {
    let open = false;
    for (const sub of session.subscribers) {
      try {
        sub.send(data);
        open = true;
      } catch {
        session.subscribers.delete(sub);
      }
    }
    if (open) return;
    session.buffer += data;
    if (session.buffer.length > BUFFER_LIMIT) {
      session.buffer = session.buffer.slice(-BUFFER_LIMIT);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    logger.info(`[Terminal] Process exited: ${terminalId}, code: ${exitCode}`);
    for (const sub of session.subscribers) {
      try {
        sub.close();
      } catch {
        // WebSocket may already be closed
      }
    }
    terminals.delete(terminalId);
  });

  // Send buffered data
  if (session.buffer) {
    const buffer = session.buffer;
    session.buffer = '';
    for (let i = 0; i < buffer.length; i += BUFFER_CHUNK) {
      ws.send(buffer.slice(i, i + BUFFER_CHUNK));
    }
  }

  return {
    session,
    cleanup: () => {
      logger.info(`[Terminal] Connection closed: ${terminalId}`);
      session.subscribers.delete(ws);
      if (session.subscribers.size === 0) {
        try {
          session.process.kill();
        } catch {
          // Process may already be dead
        }
        terminals.delete(terminalId);
      }
    },
  };
}

// Node.js WebSocket handler - will be set up by the server
export function setupNodeWebSocket(
  wss: import('ws').WebSocketServer,
  getDirectory: () => string
): void {
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!url.pathname.endsWith('/terminal/ws')) {
      ws.close();
      return;
    }

    const cwd = url.searchParams.get('cwd') || getDirectory() || process.cwd();

    try {
      const { session, cleanup } = await handleTerminalConnection(cwd, {
        send: (data: string) => ws.send(data),
        close: () => ws.close(),
      });

      ws.on('message', (data) => {
        try {
          session.process.write(String(data));
        } catch (err) {
          logger.error('[Terminal] Failed to write to PTY:', err);
        }
      });

      ws.on('close', cleanup);
      ws.on('error', cleanup);
    } catch (err) {
      logger.error('[Terminal] Failed to spawn PTY:', err);
      ws.close();
    }
  });
}

export const TerminalRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/status', (c) => {
    const activeTerminals = Array.from(terminals.values()).map((t) => ({
      id: t.id,
      cwd: t.cwd,
    }));
    return c.json({ active: activeTerminals.length, terminals: activeTerminals });
  });

  app.post('/kill/:terminalId', (c) => {
    const terminalId = c.req.param('terminalId');
    const session = terminals.get(terminalId);

    if (session) {
      try {
        session.process.kill();
      } catch {
        // Process may already be dead
      }
      for (const ws of session.subscribers) {
        ws.close();
      }
      terminals.delete(terminalId);
      return c.json({ success: true });
    }

    return c.json({ success: false, error: 'Terminal not found' }, 404);
  });

  // Only register Hono WebSocket route in Bun runtime
  if (upgradeWebSocket) {
    app.get(
      '/ws',
      upgradeWebSocket((c) => {
        const cwd = c.req.query('cwd') || c.get('directory') || process.cwd();
        let sessionData: Awaited<ReturnType<typeof handleTerminalConnection>> | undefined;

        return {
          async onOpen(_event, ws) {
            try {
              sessionData = await handleTerminalConnection(cwd, {
                send: (data: string) => (ws as unknown as { send: (d: string) => void }).send(data),
                close: () => (ws as unknown as { close: () => void }).close(),
              });
            } catch (err) {
              logger.error('[Terminal] Failed to spawn PTY:', err);
              (ws as unknown as { close: () => void }).close();
            }
          },

          onMessage(event) {
            if (!sessionData) return;
            try {
              sessionData.session.process.write(String(event.data));
            } catch (err) {
              logger.error('[Terminal] Failed to write to PTY:', err);
            }
          },

          onClose() {
            sessionData?.cleanup();
          },
        };
      })
    );
  } else {
    // In Node.js, WebSocket is handled separately via setupNodeWebSocket
    // Return info about how to connect
    app.get('/ws', (c) => {
      return c.json({
        message: 'WebSocket endpoint - connect via ws:// protocol',
        hint: 'Use WebSocket client to connect to this endpoint',
      });
    });
  }

  return app;
};
