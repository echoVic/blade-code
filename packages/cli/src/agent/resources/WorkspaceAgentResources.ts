import path from 'node:path';
import { HookManager } from '../../hooks/HookManager.js';
import { type HookConfig, HookEvent } from '../../hooks/types/HookTypes.js';
import {
  clearAllPluginResources,
  integrateAllPlugins,
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

const resourceInitializations = new Map<string, Promise<WorkspaceAgentResources>>();
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

export async function resolveWorkspaceAgentResources(
  workspaceRoot: string,
  options: {
    cliPluginDirs?: readonly string[];
    reconcilePlugins?: boolean;
  } = {}
): Promise<WorkspaceAgentResources> {
  const root = path.resolve(workspaceRoot);
  let initialization = resourceInitializations.get(root);
  if (!initialization) {
    initialization = (async () => {
      const trust = await WorkspaceTrustService.getInstance().getStatus(root);
      const subagents = getSubagentRegistry(root);
      const skills = getSkillRegistry({ cwd: root });
      const commands = CustomCommandRegistry.getInstance(root);
      const plugins = getPluginRegistry(root);

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
    })().catch((error) => {
      resourceInitializations.delete(root);
      throw error;
    });
    resourceInitializations.set(root, initialization);
  }
  const resources = await initialization;
  if (options.reconcilePlugins) {
    clearAllPluginResources(root);
    await integrateAllPlugins(root);
    await refreshWorkspaceCommunicationStyles(resources);
  }
  return resources;
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

export function resetWorkspaceAgentResources(): void {
  for (const workspaceRoot of resourceInitializations.keys()) {
    clearAllPluginResources(workspaceRoot);
  }
  resourceInitializations.clear();
  SubagentRegistry.resetInstances();
  SkillRegistry.resetInstance();
  CustomCommandRegistry.resetInstance();
  PluginRegistry.resetInstance();
}
