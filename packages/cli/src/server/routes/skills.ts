import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getSkillRegistry } from '../../skills/index.js';
import { getSkillInstaller } from '../../skills/SkillInstaller.js';

const logger = createLogger(LogCategory.SERVICE);

const SKILLS_CONFIG_PATH = path.join(homedir(), '.blade', 'skills-config.json');

interface SkillsConfig {
  disabled: string[];
}

async function loadSkillsConfig(): Promise<SkillsConfig> {
  try {
    const content = await fs.readFile(SKILLS_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { disabled: [] };
  }
}

async function saveSkillsConfig(config: SkillsConfig): Promise<void> {
  await fs.mkdir(path.dirname(SKILLS_CONFIG_PATH), { recursive: true });
  await fs.writeFile(SKILLS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const config = await loadSkillsConfig();
  if (enabled) {
    config.disabled = config.disabled.filter(n => n !== name);
  } else {
    if (!config.disabled.includes(name)) {
      config.disabled.push(name);
    }
  }
  await saveSkillsConfig(config);
}

interface CatalogSkill {
  name: string;
  description: string;
  tag: 'Official' | 'Community';
  author: string;
}

interface GitHubContent {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

let catalogCache: { data: CatalogSkill[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchOfficialSkillsCatalog(): Promise<CatalogSkill[]> {
  if (catalogCache && Date.now() - catalogCache.timestamp < CACHE_TTL) {
    return catalogCache.data;
  }

  try {
    const response = await fetch(
      'https://api.github.com/repos/anthropics/skills/contents/skills',
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Blade-Skills-Catalog',
        },
      }
    );

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status}`);
      return catalogCache?.data || [];
    }

    const contents: GitHubContent[] = await response.json();
    const skills: CatalogSkill[] = [];

    for (const item of contents) {
      if (item.type !== 'dir') continue;

      let description = `Official ${item.name} skill`;
      try {
        const skillMdResponse = await fetch(
          `https://raw.githubusercontent.com/anthropics/skills/main/skills/${item.name}/SKILL.md`,
          { headers: { 'User-Agent': 'Blade-Skills-Catalog' } }
        );
        if (skillMdResponse.ok) {
          const content = await skillMdResponse.text();
          const descMatch = content.match(/^#[^\n]*\n+([^\n#]+)/);
          if (descMatch) {
            description = descMatch[1].trim().slice(0, 100);
          }
        }
      } catch {
        // ignore, use default description
      }

      skills.push({
        name: item.name,
        description,
        tag: 'Official',
        author: 'Anthropic',
      });
    }

    catalogCache = { data: skills, timestamp: Date.now() };
    return skills;
  } catch (error) {
    logger.warn('Failed to fetch skills catalog from GitHub:', error);
    return catalogCache?.data || [];
  }
}

export const SkillsRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const registry = getSkillRegistry();
      await registry.initialize();
      const skills = registry.getAll();
      const config = await loadSkillsConfig();
      
      const result = skills.map(skill => ({
        id: skill.name,
        name: skill.name,
        enabled: !config.disabled.includes(skill.name),
        description: skill.description || '',
        version: skill.version || '1.0.0',
        provider: 'Local',
        location: skill.source === 'builtin' ? 'Built-in' : skill.basePath,
        capabilities: ['prompts'],
        allowedTools: skill.allowedTools || [],
      }));

      return c.json(result);
    } catch (error) {
      logger.error('[SkillsRoutes] Failed to get skills:', error);
      return c.json([]);
    }
  });

  app.post('/:name/toggle', async (c) => {
    try {
      const name = c.req.param('name');
      const body = await c.req.json() as { enabled: boolean };
      
      await setSkillEnabled(name, body.enabled);
      
      return c.json({ success: true, enabled: body.enabled });
    } catch (error) {
      logger.error('[SkillsRoutes] Failed to toggle skill:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.delete('/:name', async (c) => {
    try {
      const name = c.req.param('name');
      const skillPath = `${process.env.HOME}/.blade/skills/${name}`;
      
      await fs.rm(skillPath, { recursive: true, force: true });
      
      const registry = getSkillRegistry();
      await registry.refresh();
      
      return c.json({ success: true });
    } catch (error) {
      logger.error('[SkillsRoutes] Failed to uninstall skill:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.post('/install', async (c) => {
    try {
      const body = await c.req.json() as { 
        source: 'catalog' | 'repo' | 'local';
        url?: string;
        path?: string;
        name?: string;
      };
      
      const installer = getSkillInstaller();
      const registry = getSkillRegistry();
      let success = false;

      if (body.source === 'catalog' && body.name) {
        success = await installer.installOfficialSkill(body.name);
        if (!success) {
          return c.json({ success: false, error: 'Failed to install skill from catalog' }, 500);
        }
      } else if (body.source === 'repo' && body.url) {
        success = await installer.installFromRepo(body.url, body.name);
        if (!success) {
          return c.json({ success: false, error: 'Failed to install skill from repository. Make sure the repo contains a SKILL.md file.' }, 500);
        }
      } else if (body.source === 'local' && body.path) {
        success = await installer.installFromLocal(body.path, body.name);
        if (!success) {
          return c.json({ success: false, error: 'Failed to install skill from local path. Make sure the path exists and contains a SKILL.md file.' }, 500);
        }
      } else {
        return c.json({ success: false, error: 'Invalid install parameters. Required: source with corresponding url/path/name' }, 400);
      }

      await registry.refresh();
      return c.json({ success: true });
    } catch (error) {
      logger.error('[SkillsRoutes] Failed to install skill:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.get('/catalog', async (c) => {
    try {
      const catalog = await fetchOfficialSkillsCatalog();
      return c.json(catalog);
    } catch (error) {
      logger.error('[SkillsRoutes] Failed to get catalog:', error);
      return c.json([]);
    }
  });

  return app;
};
