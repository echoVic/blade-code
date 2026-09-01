import path from 'node:path';
import { HookManager } from '../../hooks/HookManager.js';
import { type HookConfig, HookEvent } from '../../hooks/types/HookTypes.js';
import {
  clearAllPluginResources,
  integrateAllPlugins,
  releasePluginIntegrationState,
} from '../../plugins/PluginIntegrator.js';
import { getPluginRegistry, PluginRegistry } from '../../plugins/PluginRegistry.js';
import { WorkspaceTrustService } from '../../security/WorkspaceTrustService.js';
import {
  BUILTIN_COMMUNICATION_STYLE_CATALOG,
  type CommunicationStyleCatalog,
} from '../../services/communicationStyle.js';
import { getSkillRegistry, SkillRegistry } from '../../skills/index.js';
import { CustomCommandRegistry } from '../../slash-commands/custom/CustomCommandRegistry.js';
import {
  getSubagentRegistry,
  SubagentRegistry,
} from '../subagents/SubagentRegistry.js';
import { resolveWorkspaceCommunicationStyles } from './WorkspaceCommunicationStyles.js';
import {
  ProjectRuleCatalog,
  resolveWorkspaceProjectRules,
} from './WorkspaceProjectRules.js';

export interface WorkspaceAgentResources {
  workspaceRoot: string;
  subagents: SubagentRegistry;
  skills: SkillRegistry;
  commands: CustomCommandRegistry;
  plugins: PluginRegistry;
  communicationStyles: CommunicationStyleCatalog;
  projectRules: ProjectRuleCatalog;
}

export interface SessionAgentResources {
  readonly projectRoot: string;
  readonly subagents: SubagentRegistry;
  readonly skills: SkillRegistry;
  readonly commands: CustomCommandRegistry;
  readonly hooks?: HookConfig;
  readonly communicationStyles: CommunicationStyleCatalog;
  readonly projectRules: ProjectRuleCatalog;
}

export const MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES = 32;
export const MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES = 64;

export class WorkspaceAgentResourceCapacityError extends Error {
  readonly capacity = MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES;

  constructor() {
    super(
      `Workspace agent resource capacity is full (${MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES})`
    );
    this.name = 'WorkspaceAgentResourceCapacityError';
  }
}

interface WorkspaceAgentResourceEntry {
  generation: number;
  users: number;
  promise: Promise<WorkspaceAgentResources>;
  resources?: WorkspaceAgentResources;
}

const resourceEntries = new Map<string, WorkspaceAgentResourceEntry>();
let resourceGeneration = 0;
let invocationPluginDirs: string[] = [];

export async function refreshWorkspaceCommunicationStyles(
  resources: WorkspaceAgentResources
): Promise<void> {
  const trust = await WorkspaceTrustService.getInstance().getStatus(
    resources.workspaceRoot
  );
  resources.communicationStyles = await resolveWorkspaceCommunicationStyles(
    resources.workspaceRoot,
    {
      projectTrusted: trust.state === 'trusted',
      plugins: resources.plugins.getActive(),
    }
  );
}

function snapshotHookConfig(config: Readonly<HookConfig>): HookConfig {
  const snapshot: HookConfig = { ...config };
  for (const event of Object.values(HookEvent)) {
    snapshot[event] = (config[event] ?? []).map((matcher) => ({
      ...matcher,
      matcher: matcher.matcher ? { ...matcher.matcher } : undefined,
      hooks: matcher.hooks.map((hook) => ({ ...hook })),
    }));
  }
  return snapshot;
}

export function configureInvocationPluginDirs(pluginDirs: readonly string[]): void {
  invocationPluginDirs = [
    ...new Set(pluginDirs.map((directory) => path.resolve(directory))),
  ];
}

function releaseWorkspaceRegistryInstances(
  workspaceRoot: string,
  registries: Pick<
    WorkspaceAgentResources,
    'subagents' | 'skills' | 'commands' | 'plugins'
  >
): void {
  releasePluginIntegrationState(workspaceRoot, registries.plugins);
  SubagentRegistry.releaseInstance(workspaceRoot, registries.subagents);
  SkillRegistry.releaseInstance({ cwd: workspaceRoot }, registries.skills);
  CustomCommandRegistry.releaseInstance(workspaceRoot, registries.commands);
  PluginRegistry.releaseInstance(workspaceRoot, registries.plugins);
}

function releaseWorkspaceResourceInstances(resources: WorkspaceAgentResources): void {
  releaseWorkspaceRegistryInstances(resources.workspaceRoot, resources);
}

function trimWorkspaceResourceEntries(): void {
  while (resourceEntries.size > MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES) {
    let evicted = false;
    for (const [root, entry] of resourceEntries) {
      if (!entry.resources || entry.users > 0) continue;
      if (resourceEntries.get(root) !== entry) continue;
      resourceEntries.delete(root);
      releaseWorkspaceResourceInstances(entry.resources);
      evicted = true;
      break;
    }
    if (!evicted) return;
  }
}

function scheduleEntryRelease(entry: WorkspaceAgentResourceEntry): void {
  const immediate = setImmediate(() => {
    entry.users = Math.max(0, entry.users - 1);
    trimWorkspaceResourceEntries();
  });
  immediate.unref?.();
}

async function initializeWorkspaceAgentResources(
  root: string,
  options: {
    cliPluginDirs?: readonly string[];
  }
): Promise<WorkspaceAgentResources> {
  const trust = await WorkspaceTrustService.getInstance().getStatus(root);
  const subagents = getSubagentRegistry(root);
  const skills = getSkillRegistry({ cwd: root });
  const commands = CustomCommandRegistry.getInstance(root);
  const plugins = getPluginRegistry(root);

  try {
    if (subagents.getAllNames().length === 0) {
      subagents.loadFromStandardLocations(trust.state === 'trusted');
    }
    await Promise.all([
      skills.initialize(),
      commands.isInitialized() ? undefined : commands.initialize(root),
      plugins.isInitialized()
        ? undefined
        : plugins.initialize(root, [
            ...(options.cliPluginDirs ?? invocationPluginDirs),
          ]),
    ]);

    clearAllPluginResources(root);
    await integrateAllPlugins(root);
    const communicationStyles = await resolveWorkspaceCommunicationStyles(root, {
      projectTrusted: trust.state === 'trusted',
      plugins: plugins.getActive(),
    });
    const projectRules = await resolveWorkspaceProjectRules(root, {
      projectTrusted: trust.state === 'trusted',
    });
    return {
      workspaceRoot: root,
      subagents,
      skills,
      commands,
      plugins,
      communicationStyles,
      projectRules,
    };
  } catch (error) {
    releaseWorkspaceRegistryInstances(root, {
      subagents,
      skills,
      commands,
      plugins,
    });
    throw error;
  }
}

function createWorkspaceResourceEntry(
  root: string,
  options: {
    cliPluginDirs?: readonly string[];
  }
): WorkspaceAgentResourceEntry {
  const entry = {
    generation: resourceGeneration,
    users: 0,
  } as WorkspaceAgentResourceEntry;
  entry.promise = initializeWorkspaceAgentResources(root, options).then(
    (resources) => {
      if (
        entry.generation !== resourceGeneration ||
        resourceEntries.get(root) !== entry
      ) {
        releaseWorkspaceResourceInstances(resources);
        return resources;
      }
      entry.resources = resources;
      trimWorkspaceResourceEntries();
      return resources;
    },
    (error) => {
      if (resourceEntries.get(root) === entry) {
        resourceEntries.delete(root);
      }
      throw error;
    }
  );
  resourceEntries.set(root, entry);
  return entry;
}

async function acquireWorkspaceAgentResources(
  workspaceRoot: string,
  options: {
    cliPluginDirs?: readonly string[];
  }
): Promise<{
  entry: WorkspaceAgentResourceEntry;
  resources: WorkspaceAgentResources;
}> {
  const root = path.resolve(workspaceRoot);
  let entry = resourceEntries.get(root);
  if (!entry) {
    trimWorkspaceResourceEntries();
    if (resourceEntries.size >= MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES) {
      throw new WorkspaceAgentResourceCapacityError();
    }
    entry = createWorkspaceResourceEntry(root, options);
  } else {
    resourceEntries.delete(root);
    resourceEntries.set(root, entry);
  }
  entry.users++;

  let resources: WorkspaceAgentResources;
  try {
    resources = await entry.promise;
  } catch (error) {
    entry.users = Math.max(0, entry.users - 1);
    trimWorkspaceResourceEntries();
    throw error;
  }
  return { entry, resources };
}

async function reconcileWorkspacePlugins(
  resources: WorkspaceAgentResources,
  reconcilePlugins: boolean | undefined
): Promise<void> {
  if (!reconcilePlugins) return;
  clearAllPluginResources(resources.workspaceRoot);
  await integrateAllPlugins(resources.workspaceRoot);
  await refreshWorkspaceCommunicationStyles(resources);
}

export async function resolveWorkspaceAgentResources(
  workspaceRoot: string,
  options: {
    cliPluginDirs?: readonly string[];
    reconcilePlugins?: boolean;
  } = {}
): Promise<WorkspaceAgentResources> {
  const acquired = await acquireWorkspaceAgentResources(workspaceRoot, options);
  try {
    await reconcileWorkspacePlugins(acquired.resources, options.reconcilePlugins);
    return acquired.resources;
  } finally {
    scheduleEntryRelease(acquired.entry);
  }
}

export async function withWorkspaceAgentResources<T>(
  workspaceRoot: string,
  operation: (resources: WorkspaceAgentResources) => Promise<T> | T,
  options: {
    cliPluginDirs?: readonly string[];
    reconcilePlugins?: boolean;
  } = {}
): Promise<T> {
  const acquired = await acquireWorkspaceAgentResources(workspaceRoot, options);
  try {
    await reconcileWorkspacePlugins(acquired.resources, options.reconcilePlugins);
    return await operation(acquired.resources);
  } finally {
    acquired.entry.users = Math.max(0, acquired.entry.users - 1);
    trimWorkspaceResourceEntries();
  }
}

export function getWorkspaceAgentResourceCacheStats(): {
  capacity: number;
  activeCapacity: number;
  entries: number;
  initialized: number;
  inFlight: number;
  activeUsers: number;
} {
  let initialized = 0;
  let activeUsers = 0;
  for (const entry of resourceEntries.values()) {
    if (entry.resources) initialized++;
    activeUsers += entry.users;
  }
  return {
    capacity: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
    activeCapacity: MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES,
    entries: resourceEntries.size,
    initialized,
    inFlight: resourceEntries.size - initialized,
    activeUsers,
  };
}

export function snapshotWorkspaceAgentResources(
  resources: WorkspaceAgentResources | SessionAgentResources
): SessionAgentResources {
  const projectRoot =
    'projectRoot' in resources ? resources.projectRoot : resources.workspaceRoot;
  return {
    projectRoot: path.resolve(projectRoot),
    subagents: resources.subagents.snapshot(),
    skills: resources.skills.snapshot(),
    commands: resources.commands.snapshot(),
    communicationStyles:
      resources.communicationStyles?.snapshot() ??
      BUILTIN_COMMUNICATION_STYLE_CATALOG.snapshot(),
    projectRules:
      resources.projectRules?.snapshot() ?? ProjectRuleCatalog.empty(projectRoot),
    hooks: snapshotHookConfig(
      'hooks' in resources && resources.hooks
        ? resources.hooks
        : HookManager.getInstance().getConfig(projectRoot)
    ),
  };
}

export function createEmptySessionAgentResources(
  projectRoot: string
): SessionAgentResources {
  const root = path.resolve(projectRoot);
  return {
    projectRoot: root,
    subagents: new SubagentRegistry(),
    skills: new SkillRegistry(),
    commands: CustomCommandRegistry.empty(root),
    hooks: { enabled: false },
    communicationStyles: BUILTIN_COMMUNICATION_STYLE_CATALOG.snapshot(),
    projectRules: ProjectRuleCatalog.empty(root),
  };
}

export function resetWorkspaceAgentResources(): void {
  resourceGeneration++;
  for (const [workspaceRoot, entry] of resourceEntries) {
    if (entry.resources) clearAllPluginResources(workspaceRoot);
  }
  resourceEntries.clear();
  SubagentRegistry.resetInstances();
  SkillRegistry.resetInstance();
  CustomCommandRegistry.resetInstance();
  PluginRegistry.resetInstance();
}
