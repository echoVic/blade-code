import fg from 'fast-glob';
import { Hono } from 'hono';
import { execSync } from 'node:child_process';
import { createLogger, LogCategory } from '../../logging/Logger.js';
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

const WEB_EXCLUDED_COMMANDS = new Set(['/theme', '/model', '/permissions']);

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
      const limit = Math.min(Number(c.req.query('limit')) || 20, 50);

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
