import {
  resetWorkspaceAgentResources,
  resolveWorkspaceAgentResources,
} from '../agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { getState } from '../store/vanilla.js';
import { getCwd } from '../utils/cwd.js';

export async function reloadWorkspaceTrustConfiguration(): Promise<void> {
  const config = await ConfigManager.getInstance().reload();
  getState().config.actions.setConfig(config);
  await McpRegistry.getInstance().disconnectAll();
  resetWorkspaceAgentResources();
  await resolveWorkspaceAgentResources(getCwd());
}
