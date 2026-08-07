import path from 'node:path';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import type { BoundProject } from '../api/schemas.js';
import { projectRegistry } from '../services/ProjectRegistry.js';
import { getCwd } from '../utils/cwd.js';

interface ProjectRegistryApi {
  list(currentPath: string): Promise<BoundProject[]>;
  bind(projectPath: string, currentPath: string): Promise<BoundProject>;
  unbind(projectPath: string): Promise<boolean>;
}

export interface ProjectsCommandDependencies {
  registry: ProjectRegistryApi;
  currentWorkspace: () => string;
  inputCwd: () => string;
  write: (line: string) => void;
}

const defaultDependencies: ProjectsCommandDependencies = {
  registry: projectRegistry,
  currentWorkspace: getCwd,
  inputCwd: () => process.cwd(),
  write: console.log,
};

interface JsonOption {
  json?: boolean;
}

interface ProjectPathOption extends JsonOption {
  path: string;
}

function resolvedInputPath(
  projectPath: string,
  dependencies: ProjectsCommandDependencies
): string {
  return path.resolve(dependencies.inputCwd(), projectPath);
}

export function formatProjectList(projects: readonly BoundProject[]): string {
  return projects
    .map((project) => {
      const marker = project.isCurrent ? '*' : ' ';
      const branch = project.gitBranch ? ` · ${project.gitBranch}` : '';
      const unavailable = project.available ? '' : ' · unavailable';
      return `${marker} ${project.name}${branch}${unavailable}\n  ${project.path}`;
    })
    .join('\n');
}

export async function runProjectsList(
  options: JsonOption,
  dependencies: ProjectsCommandDependencies = defaultDependencies
): Promise<BoundProject[]> {
  const projects = await dependencies.registry.list(dependencies.currentWorkspace());
  dependencies.write(
    options.json ? JSON.stringify(projects, null, 2) : formatProjectList(projects)
  );
  return projects;
}

export async function runProjectsAdd(
  options: ProjectPathOption,
  dependencies: ProjectsCommandDependencies = defaultDependencies
): Promise<BoundProject> {
  const project = await dependencies.registry.bind(
    resolvedInputPath(options.path, dependencies),
    dependencies.currentWorkspace()
  );
  dependencies.write(
    options.json ? JSON.stringify(project, null, 2) : `Bound project: ${project.path}`
  );
  return project;
}

export async function runProjectsRemove(
  options: ProjectPathOption,
  dependencies: ProjectsCommandDependencies = defaultDependencies
): Promise<boolean> {
  const projectPath = resolvedInputPath(options.path, dependencies);
  const removed = await dependencies.registry.unbind(projectPath);
  dependencies.write(
    options.json
      ? JSON.stringify({ path: projectPath, removed }, null, 2)
      : removed
        ? `Unbound project: ${projectPath}`
        : `Project was not bound: ${projectPath}`
  );
  return removed;
}

const jsonOption = {
  type: 'boolean',
  default: false,
  describe: 'Print machine-readable JSON',
} as const;

const projectsListCommand: CommandModule<object, JsonOption> = {
  command: 'list',
  aliases: ['ls'],
  describe: 'List bound projects',
  builder: (yargs) => yargs.option('json', jsonOption),
  handler: async (argv: ArgumentsCamelCase<JsonOption>) => {
    await runProjectsList(argv);
  },
};

const projectsAddCommand: CommandModule<object, ProjectPathOption> = {
  command: 'add <path>',
  aliases: ['bind'],
  describe: 'Bind a project folder',
  builder: (yargs) =>
    yargs
      .positional('path', {
        type: 'string',
        demandOption: true,
        describe: 'Absolute or relative project folder',
      })
      .option('json', jsonOption),
  handler: async (argv: ArgumentsCamelCase<ProjectPathOption>) => {
    await runProjectsAdd(argv);
  },
};

const projectsRemoveCommand: CommandModule<object, ProjectPathOption> = {
  command: 'remove <path>',
  aliases: ['rm', 'unbind'],
  describe: 'Unbind a project folder',
  builder: (yargs) =>
    yargs
      .positional('path', {
        type: 'string',
        demandOption: true,
        describe: 'Absolute or relative project folder',
      })
      .option('json', jsonOption),
  handler: async (argv: ArgumentsCamelCase<ProjectPathOption>) => {
    await runProjectsRemove(argv);
  },
};

export const projectsCommands: CommandModule = {
  command: 'projects',
  aliases: ['project'],
  describe: 'Manage project bindings shared with Blade Web',
  builder: (yargs) =>
    yargs
      .command(projectsListCommand)
      .command(projectsAddCommand)
      .command(projectsRemoveCommand)
      .demandCommand(1, 'Choose list, add, or remove'),
  handler: () => undefined,
};
