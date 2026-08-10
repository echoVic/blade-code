import { useDebounceFn, useInfiniteScroll, useRequest } from 'ahooks';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { requestJson } from '@/lib/http';
import {
  restoreFocusToSelector,
  restoreMobileNavigationFocus,
} from '@/lib/mobileNavigationFocus';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';

interface McpServer {
  id: string;
  name: string;
  status: 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'error';
  endpoint: string;
  description: string;
  tools: string[];
  completionSupported?: boolean;
  tasks?: {
    enabled: boolean;
    defaultTtlMs: number;
    pollIntervalMs: number;
    maxTasksPerSession: number;
    maxLifetimeMs: number;
  };
  prompts?: Array<{
    name: string;
    arguments: Array<{ name: string; required: boolean }>;
  }>;
  resourceTemplates?: Array<{
    uriTemplate: string;
    variables?: string[];
  }>;
  connectedAt?: string;
  error?: string;
  recovery?: {
    phase: 'reconnecting' | 'recovered' | 'failed';
    reason: string;
    attempt: number;
    maxAttempts: number;
    nextRetryAt?: number;
    error?: string;
  };
  logging?: {
    enabled: boolean;
    level: McpLogLevel;
  };
  instructions?: {
    text?: string;
    sourceBytes: number;
    projectedBytes: number;
    sha256: string;
    truncated: boolean;
    detailsOmitted: boolean;
  };
  oauthEnabled: boolean;
  oauthStatus:
    | 'disabled'
    | 'unavailable'
    | 'unauthenticated'
    | 'authorizing'
    | 'authenticated'
    | 'error';
}

type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

interface McpLogEntry {
  revision: number;
  serverName: string;
  level: McpLogLevel;
  logger?: string;
  message: string;
  projectedBytes: number;
  dataSha256: string;
  truncated: boolean;
  detailsOmitted: boolean;
  timestamp: number;
  synthetic?: boolean;
}

interface McpLogSnapshot {
  revision: number;
  entries: McpLogEntry[];
}

interface McpCompletionTarget {
  key: string;
  label: string;
  reference: { type: 'prompt'; name: string } | { type: 'resource'; uri: string };
  argument: string;
}

interface McpCompletionResult {
  values: string[];
  total?: number;
  hasMore: boolean;
  sourceValueCount: number;
  sourceBytes: number;
  projectedBytes: number;
  sha256: string;
  truncated: boolean;
}

interface NpmPackage {
  name: string;
  description: string;
  version: string;
  publisher?: { username: string };
  keywords?: string[];
  links?: { npm?: string; homepage?: string; repository?: string };
  date: string;
}

interface NpmSearchResult {
  objects: Array<{
    package: NpmPackage;
    score: { final: number };
    downloads: { monthly: number };
  }>;
  total: number;
}

const STATUS_STYLES: Record<McpServer['status'], string> = {
  connected: 'text-[#16A34A] dark:text-[#22C55E]',
  connecting: 'text-[#2563eb] dark:text-[#3b82f6]',
  reconnecting: 'text-[#2563eb] dark:text-[#60a5fa]',
  offline: 'text-[#f59e0b]',
  error: 'text-[#ef4444]',
};

const STATUS_LABELS: Record<McpServer['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  reconnecting: 'Recovering...',
  offline: 'Offline',
  error: 'Error',
};

const OAUTH_STATUS_LABELS: Record<McpServer['oauthStatus'], string> = {
  disabled: 'Not configured',
  unavailable: 'Unavailable in this runtime',
  unauthenticated: 'Authorization required',
  authorizing: 'Waiting for authorization...',
  authenticated: 'Authorized',
  error: 'Authorization failed',
};

const PAGE_SIZE = 20;
const MCP_LOG_LEVELS: readonly McpLogLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

const serverStatusLabel = (server: McpServer): string => {
  if (server.status !== 'reconnecting' || !server.recovery) {
    return STATUS_LABELS[server.status];
  }
  return `Recovering ${server.recovery.attempt}/${server.recovery.maxAttempts}`;
};

const fetchServers = async (): Promise<McpServer[]> => {
  return requestJson<McpServer[]>('/mcp');
};

const fetchServerLogs = async (serverName: string): Promise<McpLogSnapshot> => {
  return requestJson<McpLogSnapshot>(
    `/mcp/${encodeURIComponent(serverName)}/logs?limit=20`
  );
};

const DEFAULT_SEARCH_QUERY = 'mcp server @modelcontextprotocol';
const MIN_SEARCH_LENGTH = 3;

const packageServerName = (packageName: string): string =>
  packageName
    .split('/')
    .pop()
    ?.replace(/^server-/, '') || packageName;

const fetchNpmPackages = async (
  query: string,
  from: number
): Promise<{ list: NpmPackage[]; total: number; hasMore: boolean }> => {
  const searchQuery =
    query && query.length >= MIN_SEARCH_LENGTH ? query : DEFAULT_SEARCH_QUERY;
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=${PAGE_SIZE}&from=${from}`;
  const data = await requestJson<NpmSearchResult>(url);
  return {
    list: data.objects.map((obj) => obj.package),
    total: data.total,
    hasMore: from + PAGE_SIZE < data.total,
  };
};

export function McpModal() {
  const { isMcpOpen, toggleMcp } = useAppStore();
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed');
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serverSearch, setServerSearch] = useState('');
  const [serverActionError, setServerActionError] = useState<string | null>(null);
  const [oauthAuthorization, setOAuthAuthorization] = useState<{
    serverName: string;
    url: string;
  } | null>(null);
  const [pendingServerAction, setPendingServerAction] = useState<{
    type: 'connect' | 'disconnect' | 'delete' | 'login' | 'logout';
    name: string;
  } | null>(null);
  const [pendingLogLevel, setPendingLogLevel] = useState<McpLogLevel | null>(null);
  const [completionTargetKey, setCompletionTargetKey] = useState<string | null>(null);
  const [completionValue, setCompletionValue] = useState('');
  const [completionResult, setCompletionResult] = useState<McpCompletionResult | null>(
    null
  );
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(null);
  const [catalogSearchInput, setCatalogSearchInput] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [installPackage, setInstallPackage] = useState<NpmPackage | null>(null);
  const catalogRef = useRef<HTMLDivElement>(null);

  const { run: debouncedSetSearch } = useDebounceFn(
    (value: string) => {
      setCatalogSearch(value);
    },
    { wait: 500 }
  );

  const {
    data: servers = [],
    loading,
    error: serversError,
    run: loadServers,
    runAsync: loadServersAsync,
  } = useRequest(fetchServers, {
    refreshDeps: [isMcpOpen],
    ready: isMcpOpen,
    onSuccess: (data) => {
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id);
      }
    },
  });

  const {
    data: logSnapshot,
    loading: logsLoading,
    error: logsError,
    runAsync: loadLogs,
  } = useRequest(fetchServerLogs, {
    manual: true,
  });

  const {
    data: catalogData,
    loading: catalogLoading,
    loadingMore,
    noMore,
    error: catalogError,
    reload: reloadCatalog,
  } = useInfiniteScroll(
    async (d) => {
      const from = d?.list?.length ?? 0;
      return fetchNpmPackages(catalogSearch, from);
    },
    {
      target: catalogRef,
      isNoMore: (d) => !d?.hasMore,
      reloadDeps: [catalogSearch],
      manual: !isMcpOpen || tab !== 'catalog',
    }
  );

  const {
    runAsync: addServer,
    loading: addingServer,
    error: addServerError,
  } = useRequest(
    async (config: {
      name: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    }) => {
      await requestJson<{ success: boolean }>('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: config.name, config }),
      });
    },
    {
      manual: true,
      onSuccess: () => {
        void loadServersAsync();
        setAddServerOpen(false);
        setInstallPackage(null);
        setInstallingName(null);
      },
      onError: () => {
        setInstallingName(null);
      },
    }
  );

  const filteredServers = useMemo(() => {
    const query = serverSearch.trim().toLowerCase();
    if (!query) return servers;
    return servers.filter((server) =>
      [server.name, server.endpoint, server.description].some((value) =>
        value.toLowerCase().includes(query)
      )
    );
  }, [serverSearch, servers]);

  const selectedServer = useMemo(
    () =>
      filteredServers.find((server) => server.id === selectedId) ?? filteredServers[0],
    [filteredServers, selectedId]
  );

  const completionTargets = useMemo<McpCompletionTarget[]>(() => {
    if (!selectedServer) return [];
    const promptTargets = (selectedServer.prompts ?? []).flatMap((prompt) =>
      prompt.arguments.map((argument) => ({
        key: `prompt:${prompt.name}:${argument.name}`,
        label: `${prompt.name}.${argument.name}`,
        reference: { type: 'prompt' as const, name: prompt.name },
        argument: argument.name,
      }))
    );
    const resourceTargets = (selectedServer.resourceTemplates ?? []).flatMap(
      (template) =>
        (template.variables ?? []).map((variable) => ({
          key: `resource:${template.uriTemplate}:${variable}`,
          label: `${template.uriTemplate} · ${variable}`,
          reference: {
            type: 'resource' as const,
            uri: template.uriTemplate,
          },
          argument: variable,
        }))
    );
    return [...promptTargets, ...resourceTargets];
  }, [selectedServer]);
  const completionTarget =
    completionTargets.find((target) => target.key === completionTargetKey) ??
    completionTargets[0];

  useEffect(() => {
    if (
      !isMcpOpen ||
      !servers.some(
        (server) =>
          server.oauthStatus === 'authorizing' ||
          server.status === 'connecting' ||
          server.status === 'reconnecting'
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadServersAsync();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isMcpOpen, loadServersAsync, servers]);

  useEffect(() => {
    if (
      oauthAuthorization &&
      servers.some(
        (server) =>
          server.name === oauthAuthorization.serverName &&
          (server.oauthStatus === 'authenticated' ||
            server.oauthStatus === 'disabled' ||
            server.oauthStatus === 'unavailable')
      )
    ) {
      setOAuthAuthorization(null);
    }
  }, [oauthAuthorization, servers]);

  useEffect(() => {
    if (!isMcpOpen || tab !== 'installed' || !selectedServer) return;
    void loadLogs(selectedServer.name).catch(() => undefined);
  }, [isMcpOpen, loadLogs, selectedServer, tab]);

  const runServerAction = async (
    type: 'connect' | 'disconnect' | 'delete',
    name: string
  ) => {
    setPendingServerAction({ type, name });
    setServerActionError(null);
    try {
      const suffix = type === 'delete' ? '' : `/${type}`;
      await requestJson<{ success: boolean }>(
        `/mcp/${encodeURIComponent(name)}${suffix}`,
        { method: type === 'delete' ? 'DELETE' : 'POST' }
      );
      await loadServersAsync();
      if (type === 'delete') {
        setDeleteConfirmName(null);
        setSelectedId(null);
      }
    } catch (error) {
      setServerActionError(
        error instanceof Error ? error.message : `Failed to ${type} server`
      );
    } finally {
      setPendingServerAction(null);
    }
  };

  const runOAuthAction = async (type: 'login' | 'logout', server: McpServer) => {
    setPendingServerAction({ type, name: server.name });
    setServerActionError(null);
    try {
      if (type === 'login') {
        const result = await requestJson<{
          success: boolean;
          authorizationUrl: string;
        }>(`/mcp/${encodeURIComponent(server.name)}/oauth/login`, {
          method: 'POST',
        });
        setOAuthAuthorization({
          serverName: server.name,
          url: result.authorizationUrl,
        });
      } else {
        await requestJson<{ success: boolean }>(
          `/mcp/${encodeURIComponent(server.name)}/oauth/logout`,
          { method: 'POST' }
        );
        setOAuthAuthorization(null);
      }
      await loadServersAsync();
    } catch (error) {
      setServerActionError(
        error instanceof Error ? error.message : `Failed to ${type} MCP OAuth`
      );
    } finally {
      setPendingServerAction(null);
    }
  };

  const setLoggingLevel = async (
    server: McpServer,
    level: McpLogLevel
  ): Promise<void> => {
    setPendingLogLevel(level);
    setServerActionError(null);
    try {
      await requestJson<{ success: boolean }>(
        `/mcp/${encodeURIComponent(server.name)}/logging-level`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        }
      );
      await loadServersAsync();
      void loadLogs(server.name).catch(() => undefined);
    } catch (error) {
      setServerActionError(
        error instanceof Error ? error.message : 'Failed to set MCP logging level'
      );
    } finally {
      setPendingLogLevel(null);
    }
  };

  const runCompletion = async (server: McpServer): Promise<void> => {
    if (!completionTarget) return;
    setCompletionLoading(true);
    setCompletionError(null);
    setCompletionResult(null);
    try {
      const result = await requestJson<McpCompletionResult>(
        `/mcp/${encodeURIComponent(server.name)}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: completionTarget.reference,
            argument: {
              name: completionTarget.argument,
              value: completionValue,
            },
          }),
        }
      );
      setCompletionResult(result);
    } catch (error) {
      setCompletionError(
        error instanceof Error ? error.message : 'MCP completion failed'
      );
    } finally {
      setCompletionLoading(false);
    }
  };

  const installedPackages = useMemo(() => {
    return new Set(servers.map((s) => s.name.toLowerCase()));
  }, [servers]);

  const handleInstallFromCatalog = (pkg: NpmPackage) => {
    setInstallPackage(pkg);
  };

  const isOfficialPackage = (name: string) => name.startsWith('@modelcontextprotocol/');

  const getPackageTag = (pkg: NpmPackage): 'Official' | 'Popular' | 'Community' => {
    if (isOfficialPackage(pkg.name)) return 'Official';
    return 'Community';
  };

  return (
    <>
      <Dialog open={isMcpOpen} onOpenChange={toggleMcp}>
        <DialogContent
          onCloseAutoFocus={restoreMobileNavigationFocus}
          className="flex h-[min(680px,calc(100dvh-24px))] flex-col gap-0 overflow-hidden rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[900px]"
          aria-describedby={undefined}
          hideCloseButton
        >
          <DialogTitle className="sr-only">MCP</DialogTitle>
          <div className="flex flex-1 min-h-0">
            <div className="flex overflow-hidden flex-col flex-1 gap-4 p-4 min-h-0 sm:gap-5 sm:p-8">
              <div className="flex justify-between items-center shrink-0">
                <h2 className="text-lg font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
                  MCP
                </h2>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={loadServers}
                    aria-label="Refresh MCP servers"
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                    disabled={loading}
                  >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </button>
                  <button
                    data-mcp-add-server-trigger
                    onClick={() => setAddServerOpen(true)}
                    className="h-8 px-3 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-xs font-mono font-semibold flex items-center gap-1 hover:bg-[#D1D5DB] dark:hover:bg-[#32323a]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add server
                  </button>
                  <button
                    onClick={toggleMcp}
                    aria-label="Close MCP"
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 p-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] w-fit shrink-0">
                <TabButton
                  active={tab === 'installed'}
                  onClick={() => setTab('installed')}
                >
                  Installed ({servers.length})
                </TabButton>
                <TabButton
                  active={tab === 'catalog'}
                  onClick={() => {
                    setTab('catalog');
                    if (!catalogData) reloadCatalog();
                  }}
                >
                  Catalog
                </TabButton>
              </div>

              {serverActionError && (
                <div
                  role="alert"
                  className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 min-w-0">{serverActionError}</span>
                  <button
                    type="button"
                    onClick={() => setServerActionError(null)}
                    className="underline shrink-0"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {tab === 'installed' ? (
                <div className="flex overflow-hidden flex-col flex-1 gap-3 min-h-0 sm:flex-row sm:gap-5">
                  <div className="flex h-[180px] w-full shrink-0 flex-col gap-3 overflow-hidden sm:h-auto sm:w-[220px]">
                    <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5] shrink-0">
                      Servers
                    </span>
                    <input
                      type="search"
                      aria-label="Search installed MCP servers"
                      value={serverSearch}
                      onChange={(event) => setServerSearch(event.target.value)}
                      placeholder="Search servers..."
                      className="h-8 shrink-0 rounded-md border border-transparent bg-[#F3F4F6] px-3 text-[12px] font-mono text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#D1D5DB] dark:bg-[#18181b] dark:text-[#E5E5E5] dark:placeholder:text-[#71717a] dark:focus:border-[#3f3f46]"
                    />
                    <div className="flex overflow-y-auto flex-col flex-1 gap-2 pr-1 min-h-0">
                      {loading && servers.length === 0 && (
                        <div
                          role="status"
                          className="flex items-center justify-center gap-2 py-8 text-sm font-mono text-[#9CA3AF] dark:text-[#71717a]"
                        >
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading servers...
                        </div>
                      )}
                      {serversError && !loading && (
                        <div
                          role="alert"
                          className="flex flex-col gap-2 items-center py-6 font-mono text-xs text-center text-red-600 dark:text-red-400"
                        >
                          <span>{serversError.message}</span>
                          <button
                            type="button"
                            onClick={loadServers}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-[11px] dark:border-red-900"
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {!serversError && !loading && filteredServers.length === 0 && (
                        <div className="text-center py-8 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                          {serverSearch
                            ? 'No servers match your search'
                            : 'No MCP servers configured'}
                        </div>
                      )}
                      {filteredServers.map((server) => (
                        <button
                          key={server.id}
                          onClick={() => {
                            setSelectedId(server.id);
                            setDeleteConfirmName(null);
                            setServerActionError(null);
                            setCompletionTargetKey(null);
                            setCompletionValue('');
                            setCompletionResult(null);
                            setCompletionError(null);
                          }}
                          className={cn(
                            'text-left rounded-lg px-3 py-2 flex flex-col gap-1 transition-colors shrink-0',
                            server.id === selectedServer?.id
                              ? 'bg-[#E5E7EB] dark:bg-[#111827]'
                              : 'bg-white dark:bg-[#0C0C0C] hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]'
                          )}
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                              {server.name}
                            </span>
                            <span
                              className={cn(
                                'text-[11px] font-mono font-semibold',
                                STATUS_STYLES[server.status]
                              )}
                            >
                              {serverStatusLabel(server)}
                            </span>
                          </div>
                          <span className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8] truncate">
                            {server.endpoint}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedServer ? (
                    <div className="flex overflow-y-auto flex-col flex-1 gap-3 pr-2 min-h-0">
                      <div className="flex justify-between items-center shrink-0">
                        <span className="text-base font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                          {selectedServer.name}
                        </span>
                        <span
                          className={cn(
                            'text-xs font-mono font-semibold',
                            STATUS_STYLES[selectedServer.status]
                          )}
                        >
                          {serverStatusLabel(selectedServer)}
                        </span>
                      </div>
                      <p className="text-[12px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                        {selectedServer.description}
                      </p>
                      {selectedServer.error && (
                        <p className="text-[12px] font-mono text-[#ef4444]">
                          Error: {selectedServer.error}
                        </p>
                      )}
                      {selectedServer.instructions && (
                        <div className="rounded-md bg-[#F3F4F6] px-3 py-2 dark:bg-[#18181b]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-wide text-[#9CA3AF] dark:text-[#71717a]">
                              Server instructions
                            </span>
                            <span className="truncate text-[9px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                              sha256 {selectedServer.instructions.sha256}
                            </span>
                          </div>
                          <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[11px] font-mono text-[#374151] dark:text-[#d4d4d8]">
                            {selectedServer.instructions.text ??
                              '[details omitted by runtime policy]'}
                          </pre>
                          {(selectedServer.instructions.truncated ||
                            selectedServer.instructions.detailsOmitted) && (
                            <span className="mt-1 block text-[9px] font-mono text-amber-600 dark:text-amber-400">
                              {selectedServer.instructions.detailsOmitted
                                ? 'Details omitted'
                                : 'Truncated to the safe display budget'}
                            </span>
                          )}
                        </div>
                      )}
                      {selectedServer.tasks && (
                        <div className="flex items-center justify-between gap-3 rounded-md bg-[#F3F4F6] px-3 py-2 dark:bg-[#18181b]">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[10px] font-mono uppercase tracking-wide text-[#9CA3AF] dark:text-[#71717a]">
                              Experimental MCP Tasks
                            </span>
                            <span className="text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                              {selectedServer.tasks.enabled
                                ? `${selectedServer.tasks.maxTasksPerSession} per Session · ${selectedServer.tasks.pollIntervalMs}ms poll`
                                : 'Disabled by default'}
                            </span>
                          </div>
                          <span
                            className={cn(
                              'text-[10px] font-mono font-semibold uppercase',
                              selectedServer.tasks.enabled
                                ? 'text-[#16A34A] dark:text-[#22C55E]'
                                : 'text-[#9CA3AF] dark:text-[#71717a]'
                            )}
                          >
                            {selectedServer.tasks.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                      )}

                      {selectedServer.oauthEnabled && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[#F3F4F6] px-3 py-2 dark:bg-[#18181b]">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[10px] font-mono uppercase tracking-wide text-[#9CA3AF] dark:text-[#71717a]">
                              OAuth
                            </span>
                            <span
                              role={
                                selectedServer.oauthStatus === 'authorizing'
                                  ? 'status'
                                  : undefined
                              }
                              className={cn(
                                'text-[11px] font-mono',
                                selectedServer.oauthStatus === 'authenticated'
                                  ? 'text-[#16A34A] dark:text-[#22C55E]'
                                  : selectedServer.oauthStatus === 'error'
                                    ? 'text-[#ef4444]'
                                    : 'text-[#6B7280] dark:text-[#a1a1aa]'
                              )}
                            >
                              {OAUTH_STATUS_LABELS[selectedServer.oauthStatus]}
                            </span>
                          </div>
                          {selectedServer.oauthStatus === 'authenticated' ? (
                            <button
                              type="button"
                              onClick={() =>
                                void runOAuthAction('logout', selectedServer)
                              }
                              disabled={pendingServerAction !== null}
                              className="h-7 rounded-md border border-[#D1D5DB] px-2.5 text-[11px] font-mono text-[#374151] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#d4d4d8]"
                            >
                              {pendingServerAction?.type === 'logout'
                                ? 'Signing out...'
                                : 'Sign out'}
                            </button>
                          ) : selectedServer.oauthStatus === 'authorizing' ? (
                            <div className="flex items-center gap-2">
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin text-[#2563eb]"
                                aria-hidden="true"
                              />
                              {oauthAuthorization?.serverName ===
                              selectedServer.name ? (
                                <a
                                  href={oauthAuthorization.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex h-7 items-center rounded-md bg-[#2563eb] px-2.5 text-[11px] font-mono font-semibold text-white dark:bg-[#3b82f6]"
                                >
                                  Continue authorization
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runOAuthAction('login', selectedServer)
                                  }
                                  disabled={pendingServerAction !== null}
                                  className="h-7 rounded-md border border-[#D1D5DB] px-2.5 text-[11px] font-mono text-[#374151] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#d4d4d8]"
                                >
                                  Resume authorization
                                </button>
                              )}
                            </div>
                          ) : selectedServer.oauthStatus === 'unavailable' ? null : (
                            <button
                              type="button"
                              onClick={() =>
                                void runOAuthAction('login', selectedServer)
                              }
                              disabled={pendingServerAction !== null}
                              className="h-7 rounded-md bg-[#2563eb] px-2.5 text-[11px] font-mono font-semibold text-white disabled:opacity-50 dark:bg-[#3b82f6]"
                            >
                              {pendingServerAction?.type === 'login'
                                ? 'Opening...'
                                : 'Authorize'}
                            </button>
                          )}
                        </div>
                      )}

                      <div className="flex gap-2 items-center">
                        {selectedServer.status === 'connected' ||
                        selectedServer.status === 'reconnecting' ? (
                          <button
                            onClick={() =>
                              void runServerAction('disconnect', selectedServer.name)
                            }
                            disabled={pendingServerAction !== null}
                            className="h-7 px-3 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
                          >
                            {pendingServerAction?.type === 'disconnect' &&
                            pendingServerAction.name === selectedServer.name
                              ? 'Disconnecting...'
                              : selectedServer.status === 'reconnecting'
                                ? 'Stop recovery'
                                : 'Disconnect'}
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              void runServerAction('connect', selectedServer.name)
                            }
                            disabled={
                              pendingServerAction !== null ||
                              (selectedServer.oauthEnabled &&
                                selectedServer.oauthStatus !== 'authenticated')
                            }
                            className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
                          >
                            {pendingServerAction?.type === 'connect' &&
                            pendingServerAction.name === selectedServer.name
                              ? 'Connecting...'
                              : selectedServer.oauthEnabled &&
                                  selectedServer.oauthStatus !== 'authenticated'
                                ? 'Authorize first'
                                : 'Connect'}
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteConfirmName(selectedServer.name)}
                          disabled={pendingServerAction !== null}
                          className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#ef4444] text-[11px] font-mono font-semibold"
                        >
                          Delete
                        </button>
                      </div>

                      {deleteConfirmName === selectedServer.name && (
                        <div
                          role="alertdialog"
                          aria-label={`Delete ${selectedServer.name}`}
                          className="flex flex-wrap gap-2 justify-between items-center px-3 py-2 bg-red-50 rounded-md border border-red-200 dark:border-red-900/60 dark:bg-red-950/30"
                        >
                          <span className="text-[11px] font-mono text-red-700 dark:text-red-300">
                            Remove this server and its saved configuration?
                          </span>
                          <div className="flex gap-2 items-center">
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmName(null)}
                              className="h-7 rounded-md px-2.5 text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void runServerAction('delete', selectedServer.name)
                              }
                              disabled={pendingServerAction !== null}
                              className="h-7 rounded-md bg-red-600 px-2.5 text-[11px] font-mono font-semibold text-white disabled:opacity-60"
                            >
                              {pendingServerAction?.type === 'delete'
                                ? 'Deleting...'
                                : 'Delete server'}
                            </button>
                          </div>
                        </div>
                      )}

                      <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                        Tools ({selectedServer.tools.length})
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {selectedServer.tools.length === 0 ? (
                          <span className="text-[12px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                            No tools available
                          </span>
                        ) : (
                          selectedServer.tools.map((tool) => (
                            <span
                              key={tool}
                              className="px-2 py-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[11px] font-mono text-[#111827] dark:text-[#E5E5E5]"
                            >
                              {tool}
                            </span>
                          ))
                        )}
                      </div>

                      <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                        Argument completion
                      </span>
                      {selectedServer.status !== 'connected' ? (
                        <span className="text-[12px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                          Connect the server to request suggestions
                        </span>
                      ) : !selectedServer.completionSupported ? (
                        <span className="text-[12px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                          Server does not advertise MCP completions
                        </span>
                      ) : completionTargets.length === 0 ? (
                        <span className="text-[12px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                          No completable prompt arguments or template variables
                        </span>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div
                            aria-label="MCP completion target"
                            className="flex max-h-20 flex-wrap gap-1 overflow-y-auto"
                          >
                            {completionTargets.map((target) => (
                              <button
                                key={target.key}
                                type="button"
                                aria-pressed={completionTarget?.key === target.key}
                                onClick={() => {
                                  setCompletionTargetKey(target.key);
                                  setCompletionResult(null);
                                  setCompletionError(null);
                                }}
                                className={cn(
                                  'max-w-full truncate rounded px-2 py-1 text-[10px] font-mono',
                                  completionTarget?.key === target.key
                                    ? 'bg-[#111827] text-white dark:bg-[#E5E5E5] dark:text-[#111827]'
                                    : 'bg-[#F3F4F6] text-[#6B7280] dark:bg-[#18181b] dark:text-[#a1a1aa]'
                                )}
                              >
                                {target.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              aria-label="MCP completion partial value"
                              value={completionValue}
                              onChange={(event) =>
                                setCompletionValue(event.target.value)
                              }
                              placeholder="Partial value"
                              className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-[#F3F4F6] px-3 text-[11px] font-mono text-[#111827] outline-none placeholder:text-[#9CA3AF] focus:border-[#D1D5DB] dark:bg-[#18181b] dark:text-[#E5E5E5] dark:placeholder:text-[#71717a] dark:focus:border-[#3f3f46]"
                            />
                            <button
                              type="button"
                              onClick={() => void runCompletion(selectedServer)}
                              disabled={completionLoading}
                              className="h-8 shrink-0 rounded-md bg-[#2563eb] px-3 text-[11px] font-mono font-semibold text-white disabled:opacity-50 dark:bg-[#3b82f6]"
                            >
                              {completionLoading ? 'Completing...' : 'Complete'}
                            </button>
                          </div>
                          {completionError && (
                            <span
                              role="alert"
                              className="text-[11px] font-mono text-red-600 dark:text-red-400"
                            >
                              {completionError}
                            </span>
                          )}
                          {completionResult && (
                            <div
                              aria-label="MCP completion suggestions"
                              className="rounded-md bg-[#F3F4F6] p-2 dark:bg-[#18181b]"
                            >
                              <div className="flex flex-wrap gap-1">
                                {completionResult.values.length > 0 ? (
                                  completionResult.values.map((value) => (
                                    <span
                                      key={value}
                                      className="rounded bg-white px-2 py-1 text-[10px] font-mono text-[#111827] dark:bg-[#0C0C0C] dark:text-[#E5E5E5]"
                                    >
                                      {value || '[empty]'}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] font-mono text-[#9CA3AF]">
                                    No suggestions
                                  </span>
                                )}
                              </div>
                              <span className="mt-1 block truncate text-[9px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                                sha256 {completionResult.sha256}
                                {completionResult.truncated ? ' · truncated' : ''}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                          Diagnostics
                        </span>
                        <button
                          type="button"
                          aria-label={`Refresh ${selectedServer.name} MCP logs`}
                          onClick={() => void loadLogs(selectedServer.name)}
                          disabled={logsLoading}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[#9CA3AF] transition-colors hover:bg-[#E5E7EB] hover:text-[#111827] disabled:opacity-50 dark:text-[#71717a] dark:hover:bg-[#27272a] dark:hover:text-[#E5E5E5]"
                        >
                          <RefreshCw
                            className={cn('h-3.5 w-3.5', logsLoading && 'animate-spin')}
                          />
                        </button>
                      </div>
                      <div
                        aria-label="MCP logging level"
                        className="flex flex-wrap gap-1"
                      >
                        {MCP_LOG_LEVELS.map((level) => (
                          <button
                            key={level}
                            type="button"
                            onClick={() => void setLoggingLevel(selectedServer, level)}
                            disabled={
                              selectedServer.status !== 'connected' ||
                              pendingLogLevel !== null
                            }
                            aria-pressed={
                              (selectedServer.logging?.level ?? 'warning') === level
                            }
                            className={cn(
                              'rounded px-2 py-1 text-[10px] font-mono transition-colors disabled:opacity-40',
                              (selectedServer.logging?.level ?? 'warning') === level
                                ? 'bg-[#111827] text-white dark:bg-[#E5E5E5] dark:text-[#111827]'
                                : 'bg-[#F3F4F6] text-[#6B7280] hover:text-[#111827] dark:bg-[#18181b] dark:text-[#a1a1aa] dark:hover:text-[#E5E5E5]'
                            )}
                          >
                            {pendingLogLevel === level ? 'Setting...' : level}
                          </button>
                        ))}
                      </div>
                      {logsError ? (
                        <div
                          role="alert"
                          className="rounded-md bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:bg-red-950/30 dark:text-red-300"
                        >
                          {logsError.message}
                        </div>
                      ) : logSnapshot?.entries.length ? (
                        <div
                          aria-label={`${selectedServer.name} MCP logs`}
                          className="flex max-h-52 flex-col gap-1.5 overflow-y-auto rounded-md bg-[#F3F4F6] p-2 dark:bg-[#18181b]"
                        >
                          {logSnapshot.entries.map((entry) => (
                            <div
                              key={entry.revision}
                              className="rounded bg-white px-2.5 py-2 dark:bg-[#0C0C0C]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={cn(
                                    'text-[10px] font-mono font-semibold uppercase',
                                    [
                                      'error',
                                      'critical',
                                      'alert',
                                      'emergency',
                                    ].includes(entry.level)
                                      ? 'text-red-600 dark:text-red-400'
                                      : entry.level === 'warning'
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-[#2563eb] dark:text-[#60a5fa]'
                                  )}
                                >
                                  {entry.level}
                                </span>
                                <span className="truncate text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                                  {entry.logger || selectedServer.name} · r
                                  {entry.revision}
                                </span>
                              </div>
                              <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] font-mono text-[#374151] dark:text-[#d4d4d8]">
                                {entry.message}
                              </pre>
                              <span className="mt-1 block truncate text-[9px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                                sha256 {entry.dataSha256}
                                {entry.truncated ? ' · truncated' : ''}
                                {entry.detailsOmitted ? ' · details omitted' : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                          {logsLoading ? 'Loading logs...' : 'No logs captured'}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-1 justify-center items-center">
                      <span className="text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                        Select a server to view details
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col flex-1 gap-4 min-h-0">
                  <div className="flex gap-3 items-center shrink-0">
                    <div className="flex-1 h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] flex items-center px-3 gap-2">
                      <Search className="h-3.5 w-3.5 text-[#9CA3AF] dark:text-[#71717a]" />
                      <input
                        type="text"
                        aria-label="Search MCP server catalog"
                        value={catalogSearchInput}
                        onChange={(e) => {
                          setCatalogSearchInput(e.target.value);
                          debouncedSetSearch(e.target.value);
                        }}
                        placeholder="Search MCP servers on npm (min 3 chars)..."
                        className="flex-1 bg-transparent text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div ref={catalogRef} className="overflow-y-auto flex-1 min-h-0">
                    {catalogError ? (
                      <div
                        role="alert"
                        className="flex flex-col gap-3 items-center py-12 font-mono text-center"
                      >
                        <AlertCircle className="w-6 h-6 text-red-500" />
                        <span className="text-xs text-red-600 dark:text-red-400">
                          {catalogError.message}
                        </span>
                        <button
                          type="button"
                          onClick={reloadCatalog}
                          className="rounded-md border border-[#E5E7EB] px-3 py-1.5 text-[11px] text-[#6B7280] dark:border-[#27272a] dark:text-[#a1a1aa]"
                        >
                          Retry catalog
                        </button>
                      </div>
                    ) : catalogLoading && !catalogData ? (
                      <div className="flex justify-center items-center py-12">
                        <Loader2 className="h-6 w-6 text-[#9CA3AF] dark:text-[#71717a] animate-spin" />
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 pb-4 sm:grid-cols-2">
                        {catalogData?.list.map((pkg) => {
                          const isInstalled = installedPackages.has(
                            packageServerName(pkg.name).toLowerCase()
                          );
                          const isInstalling = installingName === pkg.name;
                          const tag = getPackageTag(pkg);
                          return (
                            <div
                              key={pkg.name}
                              className="rounded-lg bg-white dark:bg-[#0C0C0C] p-4 flex flex-col gap-2"
                            >
                              <div className="flex gap-2 justify-between items-center">
                                <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5] truncate">
                                  {pkg.name}
                                </span>
                                <span
                                  className={cn(
                                    'text-[10px] font-mono px-2 py-0.5 rounded shrink-0',
                                    tag === 'Official'
                                      ? 'bg-[#16A34A]/20 dark:bg-[#22C55E]/20 text-[#16A34A] dark:text-[#22C55E]'
                                      : 'bg-[#3b82f6]/20 text-[#3b82f6]'
                                  )}
                                >
                                  {tag}
                                </span>
                              </div>
                              <p className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8] line-clamp-2">
                                {pkg.description || 'No description'}
                              </p>
                              <div className="flex items-center gap-2 text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                                <span>v{pkg.version}</span>
                                {pkg.publisher?.username && (
                                  <>
                                    <span>•</span>
                                    <span>by {pkg.publisher.username}</span>
                                  </>
                                )}
                              </div>
                              <div className="flex justify-between items-center pt-2 mt-auto">
                                <a
                                  href={
                                    pkg.links?.npm ||
                                    `https://www.npmjs.com/package/${pkg.name}`
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a] hover:text-[#111827] dark:hover:text-[#E5E5E5] flex items-center gap-1"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  npm
                                </a>
                                {isInstalled ? (
                                  <span className="text-[11px] font-mono text-[#16A34A] dark:text-[#22C55E] flex items-center gap-1">
                                    <Check className="w-3 h-3" />
                                    Installed
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleInstallFromCatalog(pkg)}
                                    disabled={isInstalling}
                                    className="h-6 px-2 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-[10px] font-mono font-semibold flex items-center gap-1 hover:bg-[#D1D5DB] dark:hover:bg-[#32323a] disabled:opacity-50"
                                  >
                                    <Download
                                      className={cn(
                                        'h-3 w-3',
                                        isInstalling && 'animate-pulse'
                                      )}
                                    />
                                    {isInstalling ? 'Installing...' : 'Install'}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {catalogData?.list.length === 0 && (
                          <div className="col-span-full py-12 text-center text-xs font-mono text-[#9CA3AF] dark:text-[#71717a]">
                            No packages found
                          </div>
                        )}
                      </div>
                    )}

                    {loadingMore && (
                      <div className="flex justify-center items-center py-4">
                        <Loader2 className="h-5 w-5 text-[#9CA3AF] dark:text-[#71717a] animate-spin" />
                      </div>
                    )}

                    {noMore && catalogData && catalogData.list.length > 0 && (
                      <div className="text-center py-4 text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                        No more packages
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#E5E7EB] dark:border-[#1f2937] shrink-0">
                    <span className="text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                      {catalogData?.total ?? 0} packages found
                    </span>
                    <a
                      href="https://glama.ai/mcp/servers"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-[#3b82f6] hover:underline flex items-center gap-1"
                    >
                      Browse more on Glama
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <McpAddServerModal
        open={addServerOpen}
        onOpenChange={setAddServerOpen}
        onAdd={addServer}
        saving={addingServer}
        error={addServerError?.message ?? null}
      />

      {installPackage && (
        <McpInstallModal
          pkg={installPackage}
          onClose={() => setInstallPackage(null)}
          installing={addingServer}
          error={addServerError?.message ?? null}
          onInstall={(config) => {
            setInstallingName(installPackage.name);
            return addServer(config);
          }}
        />
      )}
    </>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded text-[12px] font-mono font-semibold transition-colors',
        active
          ? 'bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5]'
          : 'text-[#6B7280] dark:text-[#a1a1aa]'
      )}
    >
      {children}
    </button>
  );
}

function McpAddServerModal({
  open,
  onOpenChange,
  onAdd,
  saving,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (config: {
    name: string;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }) => Promise<void>;
  saving: boolean;
  error: string | null;
}) {
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [jsonConfig, setJsonConfig] = useState(`{
  "name": "my-server",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}`);

  useEffect(() => {
    if (open) setValidationError(null);
  }, [open]);

  const handleSubmit = async () => {
    setValidationError(null);
    if (mode === 'json') {
      let config: {
        name: string;
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
      };
      try {
        config = JSON.parse(jsonConfig);
      } catch {
        setValidationError('Enter valid JSON with a server name and transport.');
        return;
      }
      await onAdd(config).catch(() => undefined);
    } else {
      if (!name || !command) {
        setValidationError('Name and command are required.');
        return;
      }
      await onAdd({
        name,
        command,
        args: args.split(' ').filter(Boolean),
      }).catch(() => undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) =>
          restoreFocusToSelector('[data-mcp-add-server-trigger]', event)
        }
        className="gap-0 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[540px]"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Add MCP Server</DialogTitle>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
              Add MCP Server
            </h3>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="Close add MCP server"
              className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 p-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] w-fit">
            <ModeButton active={mode === 'form'} onClick={() => setMode('form')}>
              Form
            </ModeButton>
            <ModeButton active={mode === 'json'} onClick={() => setMode('json')}>
              JSON
            </ModeButton>
          </div>

          {mode === 'json' ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                JSON config
              </span>
              <textarea
                aria-label="JSON configuration"
                className="min-h-[140px] rounded-md bg-white dark:bg-[#0C0C0C] text-[#111827] dark:text-[#E5E5E5] font-mono text-[12px] p-3 border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                value={jsonConfig}
                onChange={(e) => setJsonConfig(e.target.value)}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                  Server name
                </span>
                <input
                  aria-label="Server name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-server"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                  Command
                </span>
                <input
                  aria-label="Server command"
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                  Arguments (space separated)
                </span>
                <input
                  aria-label="Server arguments"
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
            </div>
          )}

          {(validationError || error) && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              {validationError || error}
            </div>
          )}

          <div className="flex gap-2 justify-end items-center pt-2">
            <button
              onClick={() => onOpenChange(false)}
              className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={saving}
              className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold disabled:opacity-60"
            >
              {saving ? 'Adding...' : 'Add Server'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function McpInstallModal({
  pkg,
  onClose,
  onInstall,
  installing,
  error,
}: {
  pkg: NpmPackage;
  onClose: () => void;
  onInstall: (config: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => Promise<void>;
  installing: boolean;
  error: string | null;
}) {
  const serverName = packageServerName(pkg.name);
  const [name, setName] = useState(serverName);
  const [args, setArgs] = useState(`-y ${pkg.name}`);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleInstall = async () => {
    setValidationError(null);
    if (!name.trim()) {
      setValidationError('Server name is required.');
      return;
    }
    await onInstall({
      name: name.trim(),
      command: 'npx',
      args: args.split(' ').filter(Boolean),
    }).catch(() => undefined);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="gap-0 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[480px]"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Install {pkg.name}</DialogTitle>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
              Install MCP Server
            </h3>
            <button
              onClick={onClose}
              aria-label="Close MCP installation"
              className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="rounded-md bg-white dark:bg-[#0C0C0C] p-3">
            <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
              {pkg.name}
            </span>
            <p className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8] mt-1">
              {pkg.description || 'No description'}
            </p>
          </div>

          <div className="h-px bg-[#E5E7EB] dark:bg-[#1f2937]" />

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                Server name
              </span>
              <input
                aria-label="Server name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
                className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                Arguments
              </span>
              <input
                aria-label="Server arguments"
                type="text"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y package-name"
                className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
              />
              <span className="text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                Command: npx {args}
              </span>
            </div>
          </div>

          {(validationError || error) && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              {validationError || error}
            </div>
          )}

          <div className="flex gap-2 justify-end items-center pt-2">
            <button
              onClick={onClose}
              className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleInstall()}
              disabled={installing}
              className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold disabled:opacity-60"
            >
              {installing ? 'Installing...' : 'Install'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded text-[12px] font-mono font-semibold transition-colors',
        active
          ? 'bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5]'
          : 'text-[#6B7280] dark:text-[#a1a1aa]'
      )}
    >
      {children}
    </button>
  );
}
