import {
  Download,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  ShieldCheck,
  Store,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestJson } from '@/lib/http';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session';

interface PluginSummary {
  name: string;
  description: string;
  version: string;
  source: 'cli' | 'project' | 'user';
  enabled: boolean;
  status: 'active' | 'inactive' | 'error';
  commands: number;
  skills: number;
  agents: number;
  hooks: number;
  mcpServers: number;
  configurable: boolean;
  managed: boolean;
  marketplace?: string;
  revision?: string;
  installedAt?: string;
  updatedAt?: string;
  compatibilityIssues: Array<{
    code: string;
    message: string;
  }>;
}

interface MarketplacePlugin {
  name: string;
  description: string;
  version?: string;
  category?: string;
  tags: string[];
  installed: boolean;
  installedVersion?: string;
}

interface MarketplaceSummary {
  name: string;
  description: string;
  sourceType: 'git' | 'local';
  revision: string;
  updatedAt: string;
  plugins: MarketplacePlugin[];
}

interface PluginSourcePolicy {
  restrictToAllowedSources: boolean;
  requireGitCommitSha: boolean;
  allowedGitHosts: string[];
  allowedMarketplaces: string[];
  allowedLocalRoots: string[];
}

interface PluginPolicyResponse {
  policy: PluginSourcePolicy;
  environmentRequiresSha: boolean;
}

const DEFAULT_POLICY: PluginSourcePolicy = {
  restrictToAllowedSources: false,
  requireGitCommitSha: false,
  allowedGitHosts: [],
  allowedMarketplaces: [],
  allowedLocalRoots: [],
};

export function PluginPanel() {
  const sessionProjectPath = useSessionStore(
    (state) => state.currentSessionRef?.projectPath
  );
  const selectedProjectPath = useSessionStore((state) => state.selectedProjectPath);
  const projectPath = useMemo(
    () =>
      sessionProjectPath ??
      selectedProjectPath ??
      new URLSearchParams(window.location.search).get('project') ??
      '',
    [selectedProjectPath, sessionProjectPath]
  );
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [marketplaces, setMarketplaces] = useState<MarketplaceSummary[]>([]);
  const [policy, setPolicy] = useState<PluginSourcePolicy>(DEFAULT_POLICY);
  const [environmentRequiresSha, setEnvironmentRequiresSha] = useState(false);
  const [gitHosts, setGitHosts] = useState('');
  const [allowedMarketplaces, setAllowedMarketplaces] = useState('');
  const [localRoots, setLocalRoots] = useState('');
  const [loadedProjectPath, setLoadedProjectPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [marketplaceSource, setMarketplaceSource] = useState('');
  const [trustSource, setTrustSource] = useState(false);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const generation = useRef(0);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const activePlugins = loadedProjectPath === projectPath ? plugins : [];
  const activeMarketplaces = loadedProjectPath === projectPath ? marketplaces : [];

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    if (!projectPath) {
      setPlugins([]);
      setLoadedProjectPath('');
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [next, nextMarketplaces, nextPolicy] = await Promise.all([
        requestJson<PluginSummary[]>(
          `/plugins?projectPath=${encodeURIComponent(projectPath)}`
        ),
        requestJson<MarketplaceSummary[]>(
          `/plugins/catalog?projectPath=${encodeURIComponent(projectPath)}`
        ),
        requestJson<PluginPolicyResponse>(
          `/plugins/policy?projectPath=${encodeURIComponent(projectPath)}`
        ),
      ]);
      if (requestGeneration !== generation.current) return;
      setPlugins(next);
      setMarketplaces(nextMarketplaces);
      setPolicy(nextPolicy.policy);
      setEnvironmentRequiresSha(nextPolicy.environmentRequiresSha);
      setGitHosts(nextPolicy.policy.allowedGitHosts.join(', '));
      setAllowedMarketplaces(nextPolicy.policy.allowedMarketplaces.join(', '));
      setLocalRoots(nextPolicy.policy.allowedLocalRoots.join(', '));
      setLoadedProjectPath(projectPath);
    } catch (loadError) {
      if (requestGeneration !== generation.current) return;
      setError(
        loadError instanceof Error ? loadError.message : 'Failed to load plugins'
      );
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const setEnabled = async (plugin: PluginSummary, enabled: boolean) => {
    const actionProjectPath = projectPath;
    setAction(plugin.name);
    setError(null);
    try {
      await requestJson(`/plugins/${encodeURIComponent(plugin.name)}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: actionProjectPath,
          enabled,
          scope: 'local',
        }),
      });
      if (projectPathRef.current === actionProjectPath) await load();
    } catch (actionError) {
      if (projectPathRef.current === actionProjectPath) {
        setError(
          actionError instanceof Error ? actionError.message : 'Failed to update plugin'
        );
      }
    } finally {
      setAction(null);
    }
  };

  const parsePolicyList = (value: string) => [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];

  const savePolicy = async () => {
    await runAction('policy:save', () =>
      requestJson('/plugins/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          scope: 'local',
          policy: {
            ...policy,
            allowedGitHosts: parsePolicyList(gitHosts),
            allowedMarketplaces: parsePolicyList(allowedMarketplaces),
            allowedLocalRoots: parsePolicyList(localRoots),
          },
        }),
      })
    );
  };

  const runAction = async (
    key: string,
    request: () => Promise<unknown>,
    after?: () => void
  ) => {
    const actionProjectPath = projectPath;
    setAction(key);
    setError(null);
    try {
      await request();
      if (projectPathRef.current === actionProjectPath) {
        after?.();
        setConfirmAction(null);
        await load();
      }
    } catch (actionError) {
      if (projectPathRef.current === actionProjectPath) {
        setError(
          actionError instanceof Error ? actionError.message : 'Plugin action failed'
        );
      }
    } finally {
      setAction(null);
    }
  };

  const install = async () => {
    const installSource = source.trim();
    if (!installSource || !trustSource) return;
    await runAction(
      'install',
      () =>
        requestJson('/plugins/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath,
            source: installSource,
            trust: true,
          }),
        }),
      () => {
        setSource('');
        setTrustSource(false);
      }
    );
  };

  const updatePlugin = async (plugin: PluginSummary) => {
    const key = `update:${plugin.name}`;
    if (confirmAction !== key) {
      setConfirmAction(key);
      return;
    }
    await runAction(key, () =>
      requestJson(`/plugins/${encodeURIComponent(plugin.name)}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath, trust: true }),
      })
    );
  };

  const uninstallPlugin = async (plugin: PluginSummary) => {
    const key = `uninstall:${plugin.name}`;
    if (confirmAction !== key) {
      setConfirmAction(key);
      return;
    }
    await runAction(key, () =>
      requestJson(`/plugins/${encodeURIComponent(plugin.name)}/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath, confirm: true }),
      })
    );
  };

  const addMarketplace = async () => {
    const nextSource = marketplaceSource.trim();
    if (!nextSource) return;
    await runAction(
      'marketplace:add',
      () =>
        requestJson('/plugins/marketplaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath, source: nextSource }),
        }),
      () => setMarketplaceSource('')
    );
  };

  const refreshMarketplace = async (marketplace: MarketplaceSummary) => {
    await runAction(`marketplace:refresh:${marketplace.name}`, () =>
      requestJson(
        `/plugins/marketplaces/${encodeURIComponent(marketplace.name)}/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath }),
        }
      )
    );
  };

  const removeMarketplace = async (marketplace: MarketplaceSummary) => {
    const key = `marketplace:remove:${marketplace.name}`;
    if (confirmAction !== key) {
      setConfirmAction(key);
      return;
    }
    await runAction(key, () =>
      requestJson(
        `/plugins/marketplaces/${encodeURIComponent(marketplace.name)}/remove`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath, confirm: true }),
        }
      )
    );
  };

  if (!projectPath) {
    return (
      <div className="font-mono text-[12px] text-[#6B7280] dark:text-[#a1a1aa]">
        Select a project to manage its plugins.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 font-mono">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
            <Package className="h-4 w-4" />
            Workspace plugins
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
          <p className="mt-1 break-all text-[10.5px] text-[#71717a]">{projectPath}</p>
          <p className="mt-1 text-[10px] text-[#9CA3AF]">
            Changes apply to future sessions and persist in local project settings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || action !== null}
          aria-label="Reload plugins"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[#E5E7EB] px-2 text-[11px] text-[#6B7280] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="rounded-md border border-[#E5E7EB] p-3 dark:border-[#27272a]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Source policy
          </div>
          <button
            type="button"
            aria-label="Save plugin source policy"
            onClick={() => void savePolicy()}
            disabled={action !== null}
            className="rounded-md border border-[#D1D5DB] px-2 py-1 text-[9.5px] text-[#6B7280] disabled:opacity-40 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
          >
            {action === 'policy:save' ? 'Saving…' : 'Save for project'}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <button
            type="button"
            role="switch"
            aria-label="Restrict plugin sources"
            aria-checked={policy.restrictToAllowedSources}
            onClick={() =>
              setPolicy((current) => ({
                ...current,
                restrictToAllowedSources: !current.restrictToAllowedSources,
              }))
            }
            className="flex items-center gap-2 text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]"
          >
            <span
              className={cn(
                'h-3.5 w-6 rounded-full p-0.5',
                policy.restrictToAllowedSources
                  ? 'bg-amber-500'
                  : 'bg-[#D1D5DB] dark:bg-[#3f3f46]'
              )}
            >
              <span
                className={cn(
                  'block h-2.5 w-2.5 rounded-full bg-white transition-transform',
                  policy.restrictToAllowedSources && 'translate-x-2.5'
                )}
              />
            </span>
            Restrict to allowlists
          </button>
          <button
            type="button"
            role="switch"
            aria-label="Require full Git commit SHA"
            aria-checked={policy.requireGitCommitSha}
            disabled={environmentRequiresSha}
            onClick={() =>
              setPolicy((current) => ({
                ...current,
                requireGitCommitSha: !current.requireGitCommitSha,
              }))
            }
            className="flex items-center gap-2 text-[9.5px] text-[#6B7280] disabled:opacity-50 dark:text-[#a1a1aa]"
          >
            <span
              className={cn(
                'h-3.5 w-6 rounded-full p-0.5',
                policy.requireGitCommitSha
                  ? 'bg-emerald-500'
                  : 'bg-[#D1D5DB] dark:bg-[#3f3f46]'
              )}
            >
              <span
                className={cn(
                  'block h-2.5 w-2.5 rounded-full bg-white transition-transform',
                  policy.requireGitCommitSha && 'translate-x-2.5'
                )}
              />
            </span>
            Require full Git SHA
            {environmentRequiresSha ? ' · environment locked' : ''}
          </button>
        </div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
          <input
            aria-label="Allowed plugin Git hosts"
            value={gitHosts}
            onChange={(event) => setGitHosts(event.target.value)}
            placeholder="github.com, *.corp.test"
            className="h-7 rounded-md border border-[#D1D5DB] bg-transparent px-2 text-[9.5px] text-[#111827] outline-none dark:border-[#3f3f46] dark:text-[#E5E5E5]"
          />
          <input
            aria-label="Allowed plugin Marketplaces"
            value={allowedMarketplaces}
            onChange={(event) => setAllowedMarketplaces(event.target.value)}
            placeholder="team-market, official"
            className="h-7 rounded-md border border-[#D1D5DB] bg-transparent px-2 text-[9.5px] text-[#111827] outline-none dark:border-[#3f3f46] dark:text-[#E5E5E5]"
          />
          <input
            aria-label="Allowed local plugin roots"
            value={localRoots}
            onChange={(event) => setLocalRoots(event.target.value)}
            placeholder="/opt/approved/plugins"
            className="h-7 rounded-md border border-[#D1D5DB] bg-transparent px-2 text-[9.5px] text-[#111827] outline-none dark:border-[#3f3f46] dark:text-[#E5E5E5]"
          />
        </div>
        {policy.restrictToAllowedSources &&
          !gitHosts.trim() &&
          !allowedMarketplaces.trim() &&
          !localRoots.trim() && (
            <p className="mt-1.5 text-[9px] text-amber-700 dark:text-amber-400">
              Empty allowlists deny every plugin source.
            </p>
          )}
      </div>

      <div className="rounded-md border border-[#E5E7EB] p-3 dark:border-[#27272a]">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
          <Download className="h-3.5 w-3.5" />
          Install trusted plugin
        </div>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Plugin source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="plugin@marketplace, owner/repo, or ./path"
            disabled={action !== null}
            className="h-8 min-w-0 flex-1 rounded-md border border-[#D1D5DB] bg-transparent px-2 text-[10.5px] text-[#111827] outline-none focus:border-[#6B7280] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#E5E5E5]"
          />
          <button
            type="button"
            onClick={() => void install()}
            disabled={!source.trim() || !trustSource || action !== null}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#111827] px-3 text-[10.5px] text-white disabled:opacity-40 dark:bg-[#E5E5E5] dark:text-[#18181b]"
          >
            {action === 'install' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Install
          </button>
        </div>
        <button
          type="button"
          role="checkbox"
          aria-checked={trustSource}
          onClick={() => setTrustSource((value) => !value)}
          className="mt-2 flex items-center gap-2 text-left text-[9.5px] text-amber-700 dark:text-amber-400"
        >
          <span
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
              trustSource
                ? 'border-amber-600 bg-amber-600 text-white'
                : 'border-[#D1D5DB] dark:border-[#52525b]'
            )}
          >
            {trustSource ? '✓' : ''}
          </span>
          I trust this source to activate Hooks, MCP servers, skills, and commands.
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-md border border-[#E5E7EB] dark:border-[#27272a]">
        {activePlugins.map((plugin) => {
          const busy = action === plugin.name;
          const capabilities = [
            plugin.commands ? `${plugin.commands} commands` : '',
            plugin.skills ? `${plugin.skills} skills` : '',
            plugin.agents ? `${plugin.agents} agents` : '',
            plugin.hooks ? `${plugin.hooks} hooks` : '',
            plugin.mcpServers ? `${plugin.mcpServers} MCP` : '',
          ].filter(Boolean);
          return (
            <div
              key={plugin.name}
              className="flex items-start justify-between gap-4 border-b border-[#E5E7EB] px-3 py-2.5 last:border-b-0 dark:border-[#27272a]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
                    {plugin.name}
                  </span>
                  <span className="text-[9.5px] text-[#9CA3AF]">v{plugin.version}</span>
                  <span className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[9px] uppercase text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]">
                    {plugin.source}
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                  {plugin.description}
                </p>
                <p className="mt-1 text-[9.5px] text-[#9CA3AF]">
                  {capabilities.join(' · ') || 'No declared resources'}
                </p>
                {plugin.managed && (
                  <p className="mt-1 text-[9px] text-[#9CA3AF]">
                    managed
                    {plugin.marketplace ? ` · ${plugin.marketplace}` : ''}
                    {plugin.revision ? ` · ${plugin.revision.slice(0, 12)}` : ''}
                  </p>
                )}
                {!plugin.configurable && (
                  <p className="mt-1 text-[9.5px] text-amber-600 dark:text-amber-400">
                    Invocation-scoped via --plugin-dir
                  </p>
                )}
                {plugin.compatibilityIssues?.map((issue) => (
                  <p
                    key={`${issue.code}:${issue.message}`}
                    className="mt-1 text-[9.5px] text-red-600 dark:text-red-400"
                  >
                    {issue.message}
                  </p>
                ))}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <button
                  type="button"
                  role="switch"
                  aria-label={
                    plugin.status === 'error'
                      ? `Unavailable ${plugin.name}`
                      : `${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`
                  }
                  aria-checked={plugin.enabled}
                  disabled={
                    plugin.status === 'error' ||
                    !plugin.configurable ||
                    busy ||
                    action !== null
                  }
                  onClick={() => void setEnabled(plugin, !plugin.enabled)}
                  className={cn(
                    'flex h-6 w-11 items-center rounded-full px-1 transition-colors disabled:opacity-40',
                    plugin.enabled ? 'bg-emerald-500' : 'bg-[#E5E7EB] dark:bg-[#27272a]'
                  )}
                >
                  <span
                    className={cn(
                      'h-4 w-4 rounded-full bg-white transition-transform',
                      plugin.enabled ? 'translate-x-5' : 'translate-x-0'
                    )}
                  />
                </button>
                {plugin.managed && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label={`Update ${plugin.name}`}
                      onClick={() => void updatePlugin(plugin)}
                      disabled={action !== null}
                      className={cn(
                        'rounded px-1.5 py-1 text-[9px] disabled:opacity-40',
                        confirmAction === `update:${plugin.name}`
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
                          : 'text-[#6B7280] hover:bg-[#F3F4F6] dark:text-[#a1a1aa] dark:hover:bg-[#27272a]'
                      )}
                    >
                      {action === `update:${plugin.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : confirmAction === `update:${plugin.name}` ? (
                        'Confirm update'
                      ) : (
                        'Update'
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Uninstall ${plugin.name}`}
                      onClick={() => void uninstallPlugin(plugin)}
                      disabled={action !== null}
                      className={cn(
                        'rounded px-1.5 py-1 text-[9px] disabled:opacity-40',
                        confirmAction === `uninstall:${plugin.name}`
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                          : 'text-[#9CA3AF] hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                      )}
                    >
                      {action === `uninstall:${plugin.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : confirmAction === `uninstall:${plugin.name}` ? (
                        'Confirm remove'
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!loading && activePlugins.length === 0 && !error && (
          <div className="px-3 py-8 text-center text-[11px] text-[#9CA3AF]">
            No plugins discovered for this project.
          </div>
        )}
      </div>

      <div className="rounded-md border border-[#E5E7EB] dark:border-[#27272a]">
        <div className="flex items-center justify-between gap-2 border-b border-[#E5E7EB] px-3 py-2 dark:border-[#27272a]">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
            <Store className="h-3.5 w-3.5" />
            Marketplaces
          </div>
          <span className="text-[9px] text-[#9CA3AF]">
            {activeMarketplaces.length} configured
          </span>
        </div>
        <div className="flex gap-2 border-b border-[#E5E7EB] p-2 dark:border-[#27272a]">
          <input
            aria-label="Marketplace source"
            value={marketplaceSource}
            onChange={(event) => setMarketplaceSource(event.target.value)}
            placeholder="owner/repo, HTTPS Git URL, or ./path"
            disabled={action !== null}
            className="h-7 min-w-0 flex-1 rounded-md border border-[#D1D5DB] bg-transparent px-2 text-[10px] text-[#111827] outline-none focus:border-[#6B7280] dark:border-[#3f3f46] dark:text-[#E5E5E5]"
          />
          <button
            type="button"
            aria-label="Add marketplace"
            onClick={() => void addMarketplace()}
            disabled={!marketplaceSource.trim() || action !== null}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#D1D5DB] px-2 text-[9.5px] text-[#6B7280] disabled:opacity-40 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
          >
            {action === 'marketplace:add' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Add
          </button>
        </div>
        {activeMarketplaces.map((marketplace) => (
          <div
            key={marketplace.name}
            className="border-b border-[#E5E7EB] px-3 py-2 last:border-b-0 dark:border-[#27272a]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10.5px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
                  {marketplace.name}
                  <span className="ml-2 font-normal text-[#9CA3AF]">
                    {marketplace.sourceType} · {marketplace.revision.slice(0, 12)}
                  </span>
                </div>
                <p className="mt-0.5 text-[9.5px] text-[#6B7280] dark:text-[#a1a1aa]">
                  {marketplace.description || 'No description'}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  aria-label={`Refresh marketplace ${marketplace.name}`}
                  disabled={action !== null}
                  onClick={() => void refreshMarketplace(marketplace)}
                  className="rounded p-1 text-[#9CA3AF] hover:bg-[#F3F4F6] disabled:opacity-40 dark:hover:bg-[#27272a]"
                >
                  {action === `marketplace:refresh:${marketplace.name}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Remove marketplace ${marketplace.name}`}
                  disabled={action !== null}
                  onClick={() => void removeMarketplace(marketplace)}
                  className={cn(
                    'rounded p-1 text-[#9CA3AF] disabled:opacity-40',
                    confirmAction === `marketplace:remove:${marketplace.name}`
                      ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                      : 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                  )}
                >
                  {confirmAction === `marketplace:remove:${marketplace.name}` ? (
                    <span className="px-1 text-[8.5px]">Confirm</span>
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </button>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {marketplace.plugins.slice(0, 12).map((plugin) => (
                <button
                  type="button"
                  key={plugin.name}
                  disabled={plugin.installed || action !== null}
                  onClick={() => {
                    setSource(`${plugin.name}@${marketplace.name}`);
                    setTrustSource(false);
                  }}
                  title={plugin.description}
                  className="rounded bg-[#F3F4F6] px-1.5 py-0.5 text-[8.5px] text-[#6B7280] disabled:opacity-40 dark:bg-[#27272a] dark:text-[#a1a1aa]"
                >
                  {plugin.name}
                  {plugin.installed ? ' · installed' : ''}
                </button>
              ))}
              {marketplace.plugins.length > 12 && (
                <span className="px-1 py-0.5 text-[8.5px] text-[#9CA3AF]">
                  +{marketplace.plugins.length - 12}
                </span>
              )}
            </div>
          </div>
        ))}
        {!loading && activeMarketplaces.length === 0 && (
          <div className="px-3 py-4 text-center text-[10px] text-[#9CA3AF]">
            Add a Marketplace to discover installable plugins.
          </div>
        )}
      </div>
    </div>
  );
}
