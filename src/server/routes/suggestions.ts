import fg from 'fast-glob';
import { Hono } from 'hono';
import { execSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getFileSystemService } from '../../services/FileSystemService.js';
import { getFuzzyCommandSuggestions } from '../../slash-commands/index.js';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
} from '../../utils/filePatterns.js';

const logger = createLogger(LogCategory.SERVICE);

const getGitBranch = (cwd: string): string | null => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
};

type Variables = {
  directory: string;
};

const DEFAULT_IGNORE_PATTERNS = [
  ...DEFAULT_EXCLUDE_DIRS.map((dir) => `${dir}/**`),
  ...DEFAULT_EXCLUDE_DIRS,
  ...DEFAULT_EXCLUDE_FILE_PATTERNS.map((pattern) => `**/${pattern}`),
];

const WEB_EXCLUDED_COMMANDS = new Set([
  '/theme',
  '/model',
  '/permissions',
  '/mcp',
  '/skills',
  '/exit',
  '/resume',
  '/ide',
  '/login',
  '/logout',
]);

export const SuggestionsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/commands', async (c) => {
    try {
      const query = c.req.query('q') || '';
      const suggestions = getFuzzyCommandSuggestions(query)
        .filter((s) => !WEB_EXCLUDED_COMMANDS.has(s.command));
      return c.json(suggestions);
    } catch (error) {
      logger.error('[SuggestionsRoutes] Failed to get command suggestions:', error);
      return c.json([]);
    }
  });

  app.get('/files', async (c) => {
    try {
      const query = c.req.query('q') || '';
      const directory = c.get('directory') || process.cwd();
      const limit = Math.min(Number(c.req.query('limit')) || 100, 1000);

      const files = await fg('**/*', {
        cwd: directory,
        dot: false,
        followSymbolicLinks: false,
        onlyFiles: false,
        markDirectories: true,
        unique: true,
        ignore: DEFAULT_IGNORE_PATTERNS,
      });

      const normalized = files.map((f) => f.replace(/\\/g, '/'));

      if (!query) {
        return c.json(normalized.slice(0, limit));
      }

      const lowerQuery = query.toLowerCase();
      const filtered = normalized
        .filter((file) => file.toLowerCase().includes(lowerQuery))
        .slice(0, limit);

      return c.json(filtered);
    } catch (error) {
      logger.error('[SuggestionsRoutes] Failed to get file suggestions:', error);
      return c.json([]);
    }
  });

  app.get('/files/tree', async (c) => {
    try {
      const directory = c.get('directory') || process.cwd();
      const subPath = c.req.query('path') || '';
      const targetDir = subPath ? path.join(directory, subPath) : directory;

      const entries = await readdir(targetDir, { withFileTypes: true });
      
      const items: Array<{ name: string; path: string; type: 'dir' | 'file' }> = entries.map((entry) => ({
        name: entry.name,
        path: subPath ? `${subPath}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
      }));

      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const excludeDirs = new Set<string>(DEFAULT_EXCLUDE_DIRS);
      const filtered = items.filter((item) => {
        const name = item.name;
        if (name.startsWith('.')) return false;
        if (excludeDirs.has(name)) return false;
        for (const pattern of DEFAULT_EXCLUDE_FILE_PATTERNS) {
          if (name.match(new RegExp(pattern.replace('*', '.*')))) return false;
        }
        return true;
      });

      return c.json(filtered);
    } catch (error) {
      logger.error('[SuggestionsRoutes] Failed to get file tree:', error);
      return c.json([]);
    }
  });

  app.get('/files/content', async (c) => {
    try {
      const rawPath = c.req.query('path');
      if (!rawPath) {
        return c.json({ error: 'Missing file path' }, 400);
      }

      const directory = c.get('directory') || process.cwd();
      const resolvedPath = path.resolve(directory, rawPath);
      const relative = path.relative(directory, resolvedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return c.json({ error: 'Invalid file path' }, 400);
      }

      const fsService = getFileSystemService();
      const stat = await fsService.stat(resolvedPath);
      if (!stat?.isFile) {
        return c.json({ error: 'File not found' }, 404);
      }

      const MAX_CHARS = 200000;
      const content = await fsService.readTextFile(resolvedPath);
      const truncated = content.length > MAX_CHARS;

      return c.json({
        path: rawPath,
        content: truncated ? content.slice(0, MAX_CHARS) : content,
        truncated,
        size: stat.size,
      });
    } catch (error) {
      logger.error('[SuggestionsRoutes] Failed to get file content:', error);
      return c.json({ error: 'Failed to read file' }, 500);
    }
  });

  app.get('/git-info', async (c) => {
    try {
      const directory = c.get('directory') || process.cwd();
      const branch = getGitBranch(directory);
      return c.json({ branch });
    } catch (error) {
      logger.error('[SuggestionsRoutes] Failed to get git info:', error);
      return c.json({ branch: null });
    }
  });

  return app;
};
