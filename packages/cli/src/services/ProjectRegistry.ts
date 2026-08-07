import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';
import type { BoundProject } from '../api/schemas.js';
import { detectGitBranch, getBladeStorageRoot } from '../context/storage/pathUtils.js';

interface StoredProject {
  path: string;
  boundAt: string;
}

interface ProjectRegistryFile {
  version: 1;
  projects: StoredProject[];
}

const REGISTRY_VERSION = 1 as const;

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.path === 'string' &&
    path.isAbsolute(project.path) &&
    typeof project.boundAt === 'string'
  );
}

async function canonicalDirectory(projectPath: string): Promise<string> {
  if (!path.isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute');
  }
  const canonical = await fs.realpath(projectPath);
  const info = await fs.stat(canonical);
  if (!info.isDirectory()) {
    throw new Error('Project path must be a directory');
  }
  return canonical;
}

export class ProjectRegistry {
  private readonly mutex = new Mutex();

  constructor(
    private readonly filePath = path.join(getBladeStorageRoot(), 'bound-projects.json')
  ) {}

  async list(currentPath: string): Promise<BoundProject[]> {
    const stored = await this.read();
    const current = await canonicalDirectory(currentPath);
    const entries = new Map<string, StoredProject>();
    for (const project of stored.projects) entries.set(project.path, project);
    if (!entries.has(current)) {
      entries.set(current, { path: current, boundAt: new Date(0).toISOString() });
    }

    const projects = await Promise.all(
      [...entries.values()].map(async (project) => {
        let available = false;
        try {
          available = (await fs.stat(project.path)).isDirectory();
        } catch {
          // Keep unavailable bindings visible so users can remove or repair them.
        }
        return {
          path: project.path,
          name: path.basename(project.path) || project.path,
          ...(available ? { gitBranch: detectGitBranch(project.path) } : {}),
          available,
          isCurrent: project.path === current,
          boundAt: project.boundAt,
        } satisfies BoundProject;
      })
    );

    return projects.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  async bind(projectPath: string, currentPath: string): Promise<BoundProject> {
    return this.mutex.runExclusive(async () => {
      const canonical = await canonicalDirectory(projectPath);
      const stored = await this.read();
      const existing = stored.projects.find((project) => project.path === canonical);
      const project = existing ?? {
        path: canonical,
        boundAt: new Date().toISOString(),
      };
      if (!existing) {
        stored.projects.push(project);
        await this.write(stored);
      }
      const current = await canonicalDirectory(currentPath);
      const gitBranch = detectGitBranch(canonical);
      return {
        path: canonical,
        name: path.basename(canonical) || canonical,
        ...(gitBranch ? { gitBranch } : {}),
        available: true,
        isCurrent: canonical === current,
        boundAt: project.boundAt,
      };
    });
  }

  async unbind(projectPath: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      if (!path.isAbsolute(projectPath)) {
        throw new Error('Project path must be absolute');
      }
      const canonical = await fs
        .realpath(projectPath)
        .catch(() => path.resolve(projectPath));
      const stored = await this.read();
      const next = stored.projects.filter((project) => project.path !== canonical);
      if (next.length === stored.projects.length) return false;
      stored.projects = next;
      await this.write(stored);
      return true;
    });
  }

  private async read(): Promise<ProjectRegistryFile> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.projects)) {
        return { version: REGISTRY_VERSION, projects: [] };
      }
      return {
        version: REGISTRY_VERSION,
        projects: parsed.projects.filter(isStoredProject),
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        error instanceof SyntaxError
      ) {
        return { version: REGISTRY_VERSION, projects: [] };
      }
      throw error;
    }
  }

  private async write(registry: ProjectRegistryFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await writeFileAtomic(this.filePath, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.chmod(this.filePath, 0o600);
  }
}

export const projectRegistry = new ProjectRegistry();
