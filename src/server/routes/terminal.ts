import type { IPty } from 'bun-pty';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.SERVICE);

interface TerminalSession {
  id: string;
  process: IPty;
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

const { upgradeWebSocket, websocket } = createBunWebSocket();

export { websocket as terminalWebSocket };

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

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const cwd = c.req.query('cwd') || c.get('directory') || process.cwd();
      const terminalId = `term-${Date.now()}`;
      
      let session: TerminalSession | undefined;

      return {
        async onOpen(_event, ws) {
          logger.info(`[Terminal] New connection: ${terminalId}, cwd: ${cwd}`);

          try {
            const { spawn } = await import('bun-pty');
            
            const shell = process.platform === 'win32' 
              ? 'powershell.exe' 
              : process.env.SHELL || '/bin/zsh';
            const shellArgs = shell.endsWith('sh') ? ['-l'] : [];

            const ptyProcess = spawn(shell, shellArgs, {
              name: 'xterm-256color',
              cwd,
              env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
              } as Record<string, string>,
            });

            session = {
              id: terminalId,
              process: ptyProcess,
              cwd,
              buffer: '',
              subscribers: new Set(),
            };

            terminals.set(terminalId, session);
            session.subscribers.add(ws as unknown as { send: (data: string) => void; close: () => void });

            ptyProcess.onData((data: string) => {
              let open = false;
              for (const sub of session!.subscribers) {
                try {
                  sub.send(data);
                  open = true;
                } catch {
                  session!.subscribers.delete(sub);
                }
              }
              if (open) return;
              session!.buffer += data;
              if (session!.buffer.length > BUFFER_LIMIT) {
                session!.buffer = session!.buffer.slice(-BUFFER_LIMIT);
              }
            });

            ptyProcess.onExit(({ exitCode }) => {
              logger.info(`[Terminal] Process exited: ${terminalId}, code: ${exitCode}`);
              for (const sub of session!.subscribers) {
                try {
                  sub.close();
                } catch {
                  // WebSocket may already be closed
                }
              }
              terminals.delete(terminalId);
            });

            if (session.buffer) {
              const buffer = session.buffer;
              session.buffer = '';
              for (let i = 0; i < buffer.length; i += BUFFER_CHUNK) {
                ws.send(buffer.slice(i, i + BUFFER_CHUNK));
              }
            }
          } catch (err) {
            logger.error('[Terminal] Failed to spawn PTY:', err);
            ws.close();
          }
        },

        onMessage(event) {
          if (!session) return;
          try {
            session.process.write(String(event.data));
          } catch (err) {
            logger.error('[Terminal] Failed to write to PTY:', err);
          }
        },

        onClose() {
          logger.info(`[Terminal] Connection closed: ${terminalId}`);
          if (session) {
            const firstSub = session.subscribers.values().next().value;
            if (firstSub) {
              session.subscribers.delete(firstSub);
            }
            if (session.subscribers.size === 0) {
              try {
                session.process.kill();
              } catch {
                // Process may already be dead
              }
              terminals.delete(terminalId);
            }
          }
        },
      };
    })
  );

  return app;
};
