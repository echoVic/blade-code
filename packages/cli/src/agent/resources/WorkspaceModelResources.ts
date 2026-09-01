import path from 'node:path';
import { ConfigManager } from '../../config/ConfigManager.js';
import type { BladeConfig } from '../../config/types.js';
import { getPiModelCatalog, PiModelCatalog } from '../../services/pi/PiModelCatalog.js';

export interface SessionModelResources {
  readonly projectRoot: string;
  readonly config: BladeConfig;
  readonly catalog: PiModelCatalog;
}

function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry)) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)])
    ) as T;
  }
  return value;
}

export function cloneWorkspaceModelConfig(config: BladeConfig): BladeConfig {
  return cloneConfigValue(config);
}

function createCatalog(config: BladeConfig, source?: PiModelCatalog): PiModelCatalog {
  const catalog = new PiModelCatalog(
    source?.credentials ?? getPiModelCatalog().credentials
  );
  catalog.configureModelProviders(config.modelProviders, config.models);
  return catalog;
}

export async function resolveWorkspaceModelResources(
  projectRoot: string,
  startupConfig: BladeConfig
): Promise<SessionModelResources> {
  const root = path.resolve(projectRoot);
  const configManager = ConfigManager.getInstance();
  const [modelConfig, runtimeSettings] = await Promise.all([
    configManager.loadWorkspaceModelConfig(root, startupConfig),
    configManager.loadWorkspaceRuntimeSettings(root, startupConfig),
  ]);
  const config: BladeConfig = {
    ...cloneWorkspaceModelConfig(startupConfig),
    ...modelConfig,
    ...runtimeSettings,
  };
  const catalog = createCatalog(config);
  configManager.validateConfig(config, catalog);
  return { projectRoot: root, config, catalog };
}

export function snapshotWorkspaceModelResources(
  resources: SessionModelResources
): SessionModelResources {
  const config = cloneWorkspaceModelConfig(resources.config);
  return {
    projectRoot: path.resolve(resources.projectRoot),
    config,
    catalog: createCatalog(config, resources.catalog),
  };
}

export function createProcessModelResources(
  projectRoot: string,
  config: BladeConfig
): SessionModelResources {
  const snapshot = cloneWorkspaceModelConfig(config);
  return {
    projectRoot: path.resolve(projectRoot),
    config: snapshot,
    catalog: createCatalog(snapshot),
  };
}
