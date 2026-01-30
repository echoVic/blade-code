import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/AppStore'
import { useDebounceFn, useInfiniteScroll, useRequest } from 'ahooks'
import { Check, Download, ExternalLink, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'

interface McpServer {
  id: string
  name: string
  status: 'connected' | 'connecting' | 'offline' | 'error'
  endpoint: string
  description: string
  tools: string[]
  connectedAt?: string
  error?: string
}

interface NpmPackage {
  name: string
  description: string
  version: string
  publisher?: { username: string }
  keywords?: string[]
  links?: { npm?: string; homepage?: string; repository?: string }
  date: string
}

interface NpmSearchResult {
  objects: Array<{
    package: NpmPackage
    score: { final: number }
    downloads: { monthly: number }
  }>
  total: number
}

type PermissionKey = 'read' | 'write' | 'shell'
type ServerPermissions = Record<PermissionKey, boolean>

const STATUS_STYLES: Record<McpServer['status'], string> = {
  connected: 'text-[#16A34A] dark:text-[#22C55E]',
  connecting: 'text-[#2563eb] dark:text-[#3b82f6]',
  offline: 'text-[#f59e0b]',
  error: 'text-[#ef4444]',
}

const STATUS_LABELS: Record<McpServer['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  offline: 'Offline',
  error: 'Error',
}

const PAGE_SIZE = 20

const fetchServers = async (): Promise<McpServer[]> => {
  const response = await fetch('/mcp')
  if (!response.ok) throw new Error('Failed to fetch servers')
  return response.json()
}

const DEFAULT_SEARCH_QUERY = 'mcp server @modelcontextprotocol'
const MIN_SEARCH_LENGTH = 3

const fetchNpmPackages = async (
  query: string,
  from: number
): Promise<{ list: NpmPackage[]; total: number; hasMore: boolean }> => {
  const searchQuery = query && query.length >= MIN_SEARCH_LENGTH ? query : DEFAULT_SEARCH_QUERY
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=${PAGE_SIZE}&from=${from}`
  const response = await fetch(url)
  if (!response.ok) throw new Error('Failed to fetch packages')
  const data: NpmSearchResult = await response.json()
  return {
    list: data.objects.map((obj) => obj.package),
    total: data.total,
    hasMore: from + PAGE_SIZE < data.total,
  }
}

export function McpModal() {
  const { isMcpOpen, toggleMcp } = useAppStore()
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed')
  const [addServerOpen, setAddServerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, ServerPermissions>>({})
  const [catalogSearchInput, setCatalogSearchInput] = useState('')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [installingName, setInstallingName] = useState<string | null>(null)
  const [installPackage, setInstallPackage] = useState<NpmPackage | null>(null)
  const catalogRef = useRef<HTMLDivElement>(null)

  const { run: debouncedSetSearch } = useDebounceFn(
    (value: string) => {
      setCatalogSearch(value)
    },
    { wait: 500 }
  )

  const {
    data: servers = [],
    loading,
    run: loadServers,
  } = useRequest(fetchServers, {
    refreshDeps: [isMcpOpen],
    ready: isMcpOpen,
    onSuccess: (data) => {
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id)
      }
    },
  })

  const {
    data: catalogData,
    loading: catalogLoading,
    loadingMore,
    noMore,
    reload: reloadCatalog,
  } = useInfiniteScroll(
    async (d) => {
      const from = d?.list?.length ?? 0
      return fetchNpmPackages(catalogSearch, from)
    },
    {
      target: catalogRef,
      isNoMore: (d) => !d?.hasMore,
      reloadDeps: [catalogSearch],
      manual: !isMcpOpen || tab !== 'catalog',
    }
  )

  const { runAsync: connectServer } = useRequest(
    async (name: string) => {
      await fetch(`/mcp/${encodeURIComponent(name)}/connect`, { method: 'POST' })
    },
    { manual: true, onSuccess: loadServers }
  )

  const { runAsync: disconnectServer } = useRequest(
    async (name: string) => {
      await fetch(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: 'POST' })
    },
    { manual: true, onSuccess: loadServers }
  )

  const { runAsync: deleteServer } = useRequest(
    async (name: string) => {
      await fetch(`/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' })
    },
    { manual: true, onSuccess: loadServers }
  )

  const { runAsync: addServer } = useRequest(
    async (config: { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }) => {
      await fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: config.name, config }),
      })
    },
    {
      manual: true,
      onSuccess: () => {
        loadServers()
        setAddServerOpen(false)
        setInstallPackage(null)
        setInstallingName(null)
      },
      onError: () => {
        setInstallingName(null)
      },
    }
  )

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? servers[0],
    [servers, selectedId]
  )

  const selectedPermissions = selectedServer
    ? (permissionOverrides[selectedServer.id] ?? { read: true, write: false, shell: false })
    : { read: true, write: false, shell: false }

  const updatePermission = (key: PermissionKey) => {
    if (!selectedServer) return
    setPermissionOverrides((prev) => ({
      ...prev,
      [selectedServer.id]: {
        ...selectedPermissions,
        [key]: !selectedPermissions[key],
      },
    }))
  }

  const installedPackages = useMemo(() => {
    return new Set(servers.map((s) => s.name.toLowerCase()))
  }, [servers])

  const handleInstallFromCatalog = (pkg: NpmPackage) => {
    setInstallPackage(pkg)
  }

  const isOfficialPackage = (name: string) => name.startsWith('@modelcontextprotocol/')

  const getPackageTag = (pkg: NpmPackage): 'Official' | 'Popular' | 'Community' => {
    if (isOfficialPackage(pkg.name)) return 'Official'
    return 'Community'
  }

  return (
    <>
      <Dialog open={isMcpOpen} onOpenChange={toggleMcp}>
        <DialogContent
          className="sm:max-w-[900px] h-[680px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl flex flex-col"
          aria-describedby={undefined}
          hideCloseButton
        >
          <DialogTitle className="sr-only">MCP</DialogTitle>
          <div className="flex flex-1 min-h-0">
            <div className="flex-1 p-8 flex flex-col gap-5 min-h-0 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <h2 className="text-lg font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">MCP</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={loadServers}
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                    disabled={loading}
                  >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </button>
                  <button
                    onClick={() => setAddServerOpen(true)}
                    className="h-8 px-3 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-xs font-mono font-semibold flex items-center gap-1 hover:bg-[#D1D5DB] dark:hover:bg-[#32323a]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add server
                  </button>
                  <button
                    onClick={toggleMcp}
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 p-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] w-fit shrink-0">
                <TabButton active={tab === 'installed'} onClick={() => setTab('installed')}>
                  Installed ({servers.length})
                </TabButton>
                <TabButton
                  active={tab === 'catalog'}
                  onClick={() => {
                    setTab('catalog')
                    if (!catalogData) reloadCatalog()
                  }}
                >
                  Catalog
                </TabButton>
              </div>

              {tab === 'installed' ? (
                <div className="flex gap-5 flex-1 min-h-0 overflow-hidden">
                  <div className="w-[220px] flex flex-col gap-3 min-h-0 overflow-hidden">
                    <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5] shrink-0">Servers</span>
                    <div className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] flex items-center px-3 text-[12px] text-[#9CA3AF] dark:text-[#71717a] font-mono shrink-0">
                      Search servers...
                    </div>
                    <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0 pr-1">
                      {servers.length === 0 && !loading && (
                        <div className="text-center py-8 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                          No MCP servers configured
                        </div>
                      )}
                      {servers.map((server) => (
                        <button
                          key={server.id}
                          onClick={() => setSelectedId(server.id)}
                          className={cn(
                            'text-left rounded-lg px-3 py-2 flex flex-col gap-1 transition-colors shrink-0',
                            server.id === selectedId
                              ? 'bg-[#E5E7EB] dark:bg-[#111827]'
                              : 'bg-white dark:bg-[#0C0C0C] hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">{server.name}</span>
                            <span className={cn('text-[11px] font-mono font-semibold', STATUS_STYLES[server.status])}>
                              {STATUS_LABELS[server.status]}
                            </span>
                          </div>
                          <span className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8] truncate">{server.endpoint}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedServer ? (
                    <div className="flex-1 flex flex-col gap-3 overflow-y-auto pr-2 min-h-0">
                      <div className="flex items-center justify-between shrink-0">
                        <span className="text-base font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">{selectedServer.name}</span>
                        <span className={cn('text-xs font-mono font-semibold', STATUS_STYLES[selectedServer.status])}>
                          {STATUS_LABELS[selectedServer.status]}
                        </span>
                      </div>
                      <p className="text-[12px] font-mono text-[#6B7280] dark:text-[#94a3b8]">{selectedServer.description}</p>
                      {selectedServer.error && (
                        <p className="text-[12px] font-mono text-[#ef4444]">Error: {selectedServer.error}</p>
                      )}

                      <div className="flex items-center gap-2">
                        {selectedServer.status === 'connected' ? (
                          <button
                            onClick={() => disconnectServer(selectedServer.name)}
                            className="h-7 px-3 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
                          >
                            Disconnect
                          </button>
                        ) : (
                          <button
                            onClick={() => connectServer(selectedServer.name)}
                            className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
                          >
                            Connect
                          </button>
                        )}
                        <button
                          onClick={() => deleteServer(selectedServer.name)}
                          className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#ef4444] text-[11px] font-mono font-semibold"
                        >
                          Delete
                        </button>
                      </div>

                      <div className="h-px bg-[#E5E7EB] dark:bg-[#1f2937]" />

                      <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">Permissions</span>
                      <PermissionRow
                        label="File read"
                        enabled={selectedPermissions.read}
                        onToggle={() => updatePermission('read')}
                      />
                      <PermissionRow
                        label="File write"
                        enabled={selectedPermissions.write}
                        onToggle={() => updatePermission('write')}
                      />
                      <PermissionRow
                        label="Shell exec"
                        enabled={selectedPermissions.shell}
                        onToggle={() => updatePermission('shell')}
                      />

                      <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                        Tools ({selectedServer.tools.length})
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {selectedServer.tools.length === 0 ? (
                          <span className="text-[12px] font-mono text-[#9CA3AF] dark:text-[#71717a]">No tools available</span>
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
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <span className="text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">Select a server to view details</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-4 flex-1 min-h-0">
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="flex-1 h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] flex items-center px-3 gap-2">
                      <Search className="h-3.5 w-3.5 text-[#9CA3AF] dark:text-[#71717a]" />
                      <input
                        type="text"
                        value={catalogSearchInput}
                        onChange={(e) => {
                          setCatalogSearchInput(e.target.value)
                          debouncedSetSearch(e.target.value)
                        }}
                        placeholder="Search MCP servers on npm (min 3 chars)..."
                        className="flex-1 bg-transparent text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div ref={catalogRef} className="flex-1 overflow-y-auto min-h-0">
                    {catalogLoading && !catalogData ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 text-[#9CA3AF] dark:text-[#71717a] animate-spin" />
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 pb-4">
                        {catalogData?.list.map((pkg) => {
                          const isInstalled = installedPackages.has(pkg.name.toLowerCase().replace(/\s+/g, '-'))
                          const isInstalling = installingName === pkg.name
                          const tag = getPackageTag(pkg)
                          return (
                            <div key={pkg.name} className="rounded-lg bg-white dark:bg-[#0C0C0C] p-4 flex flex-col gap-2">
                              <div className="flex items-center justify-between gap-2">
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
                              <div className="flex items-center justify-between mt-auto pt-2">
                                <a
                                  href={pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a] hover:text-[#111827] dark:hover:text-[#E5E5E5] flex items-center gap-1"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  npm
                                </a>
                                {isInstalled ? (
                                  <span className="text-[11px] font-mono text-[#16A34A] dark:text-[#22C55E] flex items-center gap-1">
                                    <Check className="h-3 w-3" />
                                    Installed
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleInstallFromCatalog(pkg)}
                                    disabled={isInstalling}
                                    className="h-6 px-2 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-[10px] font-mono font-semibold flex items-center gap-1 hover:bg-[#D1D5DB] dark:hover:bg-[#32323a] disabled:opacity-50"
                                  >
                                    <Download className={cn('h-3 w-3', isInstalling && 'animate-pulse')} />
                                    {isInstalling ? 'Installing...' : 'Install'}
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {loadingMore && (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-5 w-5 text-[#9CA3AF] dark:text-[#71717a] animate-spin" />
                      </div>
                    )}

                    {noMore && catalogData && catalogData.list.length > 0 && (
                      <div className="text-center py-4 text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]">No more packages</div>
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
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <McpAddServerModal open={addServerOpen} onOpenChange={setAddServerOpen} onAdd={addServer} />

      {installPackage && (
        <McpInstallModal
          pkg={installPackage}
          onClose={() => setInstallPackage(null)}
          onInstall={(config) => {
            setInstallingName(installPackage.name)
            addServer(config)
          }}
        />
      )}
    </>
  )
}

function TabButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
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
  )
}

function PermissionRow({ label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">{label}</span>
      <ToggleSwitch enabled={enabled} onChange={onToggle} />
    </div>
  )
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={cn(
        'w-9 h-5 rounded-full px-0.5 flex items-center transition-colors',
        enabled ? 'bg-[#16A34A] dark:bg-[#22C55E] justify-end' : 'bg-[#E5E7EB] dark:bg-[#27272a] justify-start'
      )}
    >
      <span className="h-4 w-4 rounded-full bg-white" />
    </button>
  )
}

function McpAddServerModal({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (config: {
    name: string
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
  }) => Promise<void>
}) {
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [jsonConfig, setJsonConfig] = useState(`{
  "name": "my-server",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}`)

  const handleSubmit = () => {
    if (mode === 'json') {
      try {
        const config = JSON.parse(jsonConfig)
        onAdd(config)
      } catch {
        alert('Invalid JSON')
      }
    } else {
      if (!name || !command) {
        alert('Name and command are required')
        return
      }
      onAdd({
        name,
        command,
        args: args.split(' ').filter(Boolean),
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[540px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Add MCP Server</DialogTitle>
        <div className="p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">Add MCP Server</h3>
            <button
              onClick={() => onOpenChange(false)}
              className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
            >
              <X className="h-4 w-4" />
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
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">JSON config</span>
              <textarea
                className="min-h-[140px] rounded-md bg-white dark:bg-[#0C0C0C] text-[#111827] dark:text-[#E5E5E5] font-mono text-[12px] p-3 border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                value={jsonConfig}
                onChange={(e) => setJsonConfig(e.target.value)}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">Server name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-server"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">Command</span>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">Arguments (space separated)</span>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => onOpenChange(false)}
              className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
            >
              Add Server
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function McpInstallModal({
  pkg,
  onClose,
  onInstall,
}: {
  pkg: NpmPackage
  onClose: () => void
  onInstall: (config: { name: string; command: string; args: string[]; env?: Record<string, string> }) => void
}) {
  const serverName = pkg.name.split('/').pop()?.replace(/^server-/, '') || pkg.name
  const [name, setName] = useState(serverName)
  const [args, setArgs] = useState(`-y ${pkg.name}`)

  const handleInstall = () => {
    if (!name.trim()) {
      alert('Server name is required')
      return
    }
    onInstall({
      name: name.trim(),
      command: 'npx',
      args: args.split(' ').filter(Boolean),
    })
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[480px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Install {pkg.name}</DialogTitle>
        <div className="p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">Install MCP Server</h3>
            <button
              onClick={onClose}
              className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="rounded-md bg-white dark:bg-[#0C0C0C] p-3">
            <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">{pkg.name}</span>
            <p className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8] mt-1">{pkg.description || 'No description'}</p>
          </div>

          <div className="h-px bg-[#E5E7EB] dark:bg-[#1f2937]" />

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">Server name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
                className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] font-mono text-[#111827] dark:text-[#E5E5E5] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:border-[#27272a]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">Arguments</span>
              <input
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

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={handleInstall}
              className="h-7 px-3 rounded-md bg-[#16A34A] dark:bg-[#22C55E] text-white dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
            >
              Install
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModeButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
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
  )
}
