import { useRequest } from 'ahooks';
import { AlertCircle, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { requestJson } from '@/lib/http';
import {
  restoreFocusToSelector,
  restoreMobileNavigationFocus,
} from '@/lib/mobileNavigationFocus';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';

interface Skill {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  version: string;
  provider: string;
  location: string;
  removable: boolean;
  capabilities: string[];
  allowedTools: string[];
}

interface CatalogSkill {
  name: string;
  description: string;
  tag: string;
  author: string;
}

const workspaceHeaders = (workspacePath: string | null): HeadersInit | undefined =>
  workspacePath ? { 'x-blade-directory': workspacePath } : undefined;

const fetchSkills = async (workspacePath: string | null): Promise<Skill[]> => {
  return requestJson<Skill[]>('/skills', {
    headers: workspaceHeaders(workspacePath),
  });
};

const fetchCatalog = async (): Promise<CatalogSkill[]> => {
  return requestJson<CatalogSkill[]>('/skills/catalog');
};

export function SkillsModal() {
  const { isSkillsOpen, toggleSkills } = useAppStore();
  const workspacePath = useSessionStore(
    (state) =>
      state.currentSessionRef?.projectPath ??
      state.selectedProjectPath ??
      state.taskWorkspaceInfo?.cwd ??
      null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchInstalled, setSearchInstalled] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    type: 'toggle' | 'delete';
    name: string;
  } | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installStatusOpen, setInstallStatusOpen] = useState(false);
  const [installStatus, setInstallStatus] = useState<
    'confirm' | 'installing' | 'failed'
  >('confirm');
  const [installError, setInstallError] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{
    source: 'catalog' | 'repo' | 'local';
    name?: string;
    url?: string;
    path?: string;
  } | null>(null);

  const {
    data: skills = [],
    loading,
    error: skillsError,
    run: loadSkills,
    runAsync: loadSkillsAsync,
  } = useRequest(() => fetchSkills(workspacePath), {
    refreshDeps: [isSkillsOpen, workspacePath],
    ready: isSkillsOpen,
    onSuccess: (data) => {
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id);
      }
    },
  });

  const {
    data: catalog = [],
    loading: catalogLoading,
    error: catalogError,
    run: loadCatalog,
  } = useRequest(fetchCatalog, {
    refreshDeps: [isSkillsOpen],
    ready: isSkillsOpen,
  });

  const filteredSkills = skills.filter((skill) =>
    skill.name.toLowerCase().includes(searchInstalled.toLowerCase())
  );

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedId) ?? skills[0],
    [skills, selectedId]
  );

  const runSkillAction = async (
    type: 'toggle' | 'delete',
    skill: Skill,
    enabled?: boolean
  ) => {
    setPendingAction({ type, name: skill.name });
    setActionError(null);
    try {
      await requestJson<{ success: boolean }>(
        type === 'delete'
          ? `/skills/${encodeURIComponent(skill.name)}`
          : `/skills/${encodeURIComponent(skill.name)}/toggle`,
        {
          method: type === 'delete' ? 'DELETE' : 'POST',
          headers: {
            ...workspaceHeaders(workspacePath),
            ...(type === 'toggle' ? { 'Content-Type': 'application/json' } : {}),
          },
          body: type === 'toggle' ? JSON.stringify({ enabled }) : undefined,
        }
      );
      await loadSkillsAsync();
      if (type === 'delete') {
        setDeleteConfirmName(null);
        setSelectedId(null);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : `Failed to ${type} skill`
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleOpenInstall = () => {
    setInstallOpen(true);
  };

  const requestInstall = (payload: {
    source: 'catalog' | 'repo' | 'local';
    name?: string;
    url?: string;
    path?: string;
  }) => {
    setPendingInstall(payload);
    setInstallError(null);
    setInstallStatus('confirm');
    setInstallStatusOpen(true);
  };

  const executeInstall = async () => {
    if (!pendingInstall) return;
    setInstallStatus('installing');
    setInstallError(null);
    try {
      const data = await requestJson<{ success: boolean; error?: string }>(
        '/skills/install',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...workspaceHeaders(workspacePath),
          },
          body: JSON.stringify(pendingInstall),
        }
      );
      if (data.success === false) {
        throw new Error(data.error || 'Failed to install skill');
      }
      await loadSkillsAsync();
      setInstallStatusOpen(false);
      setInstallOpen(false);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Failed to install skill');
      setInstallStatus('failed');
    }
  };

  return (
    <Fragment>
      <Dialog open={isSkillsOpen} onOpenChange={toggleSkills}>
        <DialogContent
          onCloseAutoFocus={restoreMobileNavigationFocus}
          className="flex h-[min(620px,calc(100dvh-24px))] flex-col gap-0 overflow-hidden rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[820px]"
          aria-describedby={undefined}
          hideCloseButton
        >
          <DialogTitle className="sr-only">Skills</DialogTitle>
          <div className="flex h-full min-h-0 min-w-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 sm:gap-5 sm:p-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
                  Skills
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    data-skill-install-trigger
                    onClick={handleOpenInstall}
                    className="h-8 px-3 rounded-md bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5] text-xs font-mono font-semibold flex items-center gap-1 hover:bg-[#D1D5DB] dark:hover:bg-[#32323a]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Install skill
                  </button>
                  <button
                    onClick={loadSkills}
                    aria-label="Refresh skills"
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                    disabled={loading}
                  >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </button>
                  <button
                    onClick={toggleSkills}
                    aria-label="Close skills"
                    className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {actionError && (
                <div
                  role="alert"
                  className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-mono text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{actionError}</span>
                  <button
                    type="button"
                    onClick={() => setActionError(null)}
                    className="shrink-0 underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden sm:flex-row sm:gap-5">
                <div className="flex h-[180px] w-full shrink-0 flex-col gap-3 overflow-hidden sm:h-auto sm:w-[220px]">
                  <div className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5] shrink-0">
                    Installed
                  </div>
                  <input
                    type="search"
                    aria-label="Search installed skills"
                    value={searchInstalled}
                    onChange={(event) => setSearchInstalled(event.target.value)}
                    placeholder="Search skills..."
                    className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:focus:border-[#27272a] shrink-0"
                  />
                  <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0 pr-1">
                    {loading && skills.length === 0 && (
                      <div
                        role="status"
                        className="flex items-center justify-center gap-2 py-8 text-sm font-mono text-[#9CA3AF] dark:text-[#71717a]"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading skills...
                      </div>
                    )}
                    {skillsError && !loading && (
                      <div
                        role="alert"
                        className="flex flex-col items-center gap-2 py-6 text-center text-xs font-mono text-red-600 dark:text-red-400"
                      >
                        <span>{skillsError.message}</span>
                        <button
                          type="button"
                          onClick={loadSkills}
                          className="rounded-md border border-red-200 px-2.5 py-1 text-[11px] dark:border-red-900"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {!skillsError && filteredSkills.length === 0 && !loading && (
                      <div className="text-center py-8 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                        {searchInstalled
                          ? 'No skills match your search'
                          : 'No skills installed'}
                      </div>
                    )}
                    {filteredSkills.map((skill) => (
                      <button
                        key={skill.id}
                        onClick={() => {
                          setSelectedId(skill.id);
                          setDeleteConfirmName(null);
                          setActionError(null);
                        }}
                        className={cn(
                          'flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors',
                          skill.id === selectedId
                            ? 'bg-[#E5E7EB] dark:bg-[#111827]'
                            : 'bg-white dark:bg-[#0C0C0C] hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]'
                        )}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                            {skill.name}
                          </span>
                          <span
                            className={cn(
                              'text-[11px] font-mono font-semibold',
                              skill.enabled
                                ? 'text-[#16A34A] dark:text-[#22C55E]'
                                : 'text-[#f59e0b]'
                            )}
                          >
                            {skill.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                        <span className="block w-full min-w-0 truncate text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                          {skill.description || 'No description'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {selectedSkill ? (
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
                    <div className="flex items-center justify-between">
                      <span className="text-base font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                        {selectedSkill.name}
                      </span>
                      <span className="text-xs font-mono text-[#9CA3AF] dark:text-[#71717a]">
                        v{selectedSkill.version}
                      </span>
                    </div>
                    <p className="text-[12px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                      {selectedSkill.description || 'No description available'}
                    </p>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          void runSkillAction(
                            'toggle',
                            selectedSkill,
                            !selectedSkill.enabled
                          )
                        }
                        disabled={pendingAction !== null}
                        className={cn(
                          'h-7 px-3 rounded-md text-[11px] font-mono font-semibold',
                          selectedSkill.enabled
                            ? 'bg-[#E5E7EB] text-[#111827] hover:bg-[#D1D5DB] dark:bg-[#27272a] dark:text-[#E5E5E5] dark:hover:bg-[#32323a]'
                            : 'bg-[#16A34A] text-white hover:bg-[#15803D] dark:bg-[#22C55E] dark:text-[#0C0C0C] dark:hover:bg-[#1ea34b]',
                          pendingAction && 'opacity-60 cursor-not-allowed'
                        )}
                      >
                        {pendingAction?.type === 'toggle' &&
                        pendingAction.name === selectedSkill.name
                          ? 'Saving...'
                          : selectedSkill.enabled
                            ? 'Disable'
                            : 'Enable'}
                      </button>
                      <button
                        onClick={() => setDeleteConfirmName(selectedSkill.name)}
                        disabled={!selectedSkill.removable || pendingAction !== null}
                        title={
                          !selectedSkill.removable
                            ? 'Only Blade user skills can be uninstalled'
                            : undefined
                        }
                        className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#ef4444] text-[11px] font-mono font-semibold flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        {!selectedSkill.removable ? 'Managed' : 'Uninstall'}
                      </button>
                    </div>

                    {deleteConfirmName === selectedSkill.name && (
                      <div
                        role="alertdialog"
                        aria-label={`Uninstall ${selectedSkill.name}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/30"
                      >
                        <span className="text-[11px] font-mono text-red-700 dark:text-red-300">
                          Remove this skill from ~/.blade/skills?
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmName(null)}
                            className="h-7 rounded-md px-2.5 text-[11px] font-mono text-[#6B7280] dark:text-[#a1a1aa]"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void runSkillAction('delete', selectedSkill)}
                            disabled={pendingAction !== null}
                            className="h-7 rounded-md bg-red-600 px-2.5 text-[11px] font-mono font-semibold text-white disabled:opacity-60"
                          >
                            {pendingAction?.type === 'delete'
                              ? 'Uninstalling...'
                              : 'Uninstall skill'}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="h-px bg-[#E5E7EB] dark:bg-[#1f2937]" />

                    <div className="flex flex-col gap-2">
                      <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                        Details
                      </span>
                      <div className="grid grid-cols-2 gap-2 text-[12px] font-mono">
                        <span className="text-[#9CA3AF] dark:text-[#71717a]">
                          Provider
                        </span>
                        <span className="text-[#111827] dark:text-[#E5E5E5]">
                          {selectedSkill.provider}
                        </span>
                        <span className="text-[#9CA3AF] dark:text-[#71717a]">
                          Location
                        </span>
                        <span className="text-[#111827] dark:text-[#E5E5E5] truncate">
                          {selectedSkill.location}
                        </span>
                      </div>
                    </div>

                    {selectedSkill.capabilities.length > 0 && (
                      <>
                        <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                          Capabilities
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {selectedSkill.capabilities.map((capability) => (
                            <span
                              key={capability}
                              className="px-2 py-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[11px] font-mono text-[#111827] dark:text-[#E5E5E5]"
                            >
                              {capability}
                            </span>
                          ))}
                        </div>
                      </>
                    )}

                    {selectedSkill.allowedTools.length > 0 && (
                      <>
                        <span className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                          Allowed Tools ({selectedSkill.allowedTools.length})
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {selectedSkill.allowedTools.map((tool) => (
                            <span
                              key={tool}
                              className="px-2 py-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[11px] font-mono text-[#111827] dark:text-[#E5E5E5]"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                      Select a skill to view details
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SkillsInstallModal
        open={installOpen}
        catalog={catalog}
        installed={skills.map((skill) => skill.name)}
        catalogLoading={catalogLoading}
        catalogError={catalogError?.message ?? null}
        onRetryCatalog={loadCatalog}
        onOpenChange={setInstallOpen}
        onInstall={requestInstall}
      />

      <SkillsInstallStatusModal
        open={installStatusOpen}
        status={installStatus}
        error={installError}
        onCancel={() => setInstallStatusOpen(false)}
        onConfirm={executeInstall}
        onRetry={() => setInstallStatus('confirm')}
      />
    </Fragment>
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

function SkillsInstallModal({
  open,
  onOpenChange,
  onInstall,
  catalog,
  installed,
  catalogLoading,
  catalogError,
  onRetryCatalog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (payload: {
    source: 'catalog' | 'repo' | 'local';
    name?: string;
    url?: string;
    path?: string;
  }) => void;
  catalog: CatalogSkill[];
  installed: string[];
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalog: () => void;
}) {
  const [tab, setTab] = useState<'catalog' | 'repo' | 'local'>('catalog');
  const [query, setQuery] = useState('');
  const [selectedCatalog, setSelectedCatalog] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');

  const filteredCatalog = catalog.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase())
  );

  const handleInstall = () => {
    if (tab === 'catalog') {
      if (!selectedCatalog) return;
      onInstall({ source: 'catalog', name: selectedCatalog });
      return;
    }
    if (tab === 'repo') {
      if (!repoUrl) return;
      onInstall({ source: 'repo', url: repoUrl });
      return;
    }
    if (!localPath) return;
    onInstall({ source: 'local', path: localPath });
  };

  const selectedIsInstalled = selectedCatalog
    ? installed.includes(selectedCatalog)
    : false;
  const installDisabled =
    (tab === 'catalog' &&
      (!selectedCatalog ||
        selectedIsInstalled ||
        catalogLoading ||
        Boolean(catalogError))) ||
    (tab === 'repo' && !repoUrl) ||
    (tab === 'local' && !localPath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) =>
          restoreFocusToSelector('[data-skill-install-trigger]', event)
        }
        className="gap-0 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white p-0 dark:border-zinc-800 dark:bg-[#09090b] sm:max-w-[540px]"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Install Skill</DialogTitle>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-[#111827] dark:text-[#E5E5E5] font-mono">
              Install Skill
            </h3>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="Close skill installation"
              className="h-8 w-8 rounded-md text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-[#71717a] dark:hover:text-[#E5E5E5] dark:hover:bg-[#27272a] transition-colors flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 p-1 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] w-fit">
            <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>
              Catalog
            </TabButton>
            <TabButton active={tab === 'repo'} onClick={() => setTab('repo')}>
              Repo
            </TabButton>
            <TabButton active={tab === 'local'} onClick={() => setTab('local')}>
              Local
            </TabButton>
          </div>

          <div className="flex flex-col gap-3">
            {tab === 'catalog' && (
              <>
                <input
                  aria-label="Search skill catalog"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search catalog..."
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:focus:border-[#27272a]"
                />
                <div className="flex max-h-[min(240px,30dvh)] flex-col gap-2 overflow-y-auto">
                  {catalogLoading && (
                    <div
                      role="status"
                      className="flex items-center justify-center gap-2 py-6 text-sm font-mono text-[#9CA3AF] dark:text-[#71717a]"
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading catalog...
                    </div>
                  )}
                  {catalogError && !catalogLoading && (
                    <div
                      role="alert"
                      className="flex flex-col items-center gap-2 py-6 text-center text-xs font-mono text-red-600 dark:text-red-400"
                    >
                      <span>{catalogError}</span>
                      <button
                        type="button"
                        onClick={onRetryCatalog}
                        className="rounded-md border border-red-200 px-2.5 py-1 text-[11px] dark:border-red-900"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {!catalogLoading && !catalogError && filteredCatalog.length === 0 && (
                    <div className="text-center py-6 text-[#9CA3AF] dark:text-[#71717a] text-sm font-mono">
                      No skills found
                    </div>
                  )}
                  {!catalogLoading &&
                    !catalogError &&
                    filteredCatalog.map((item) => {
                      const isInstalled = installed.includes(item.name);
                      const isSelected = selectedCatalog === item.name;
                      return (
                        <button
                          key={item.name}
                          onClick={() => setSelectedCatalog(item.name)}
                          className={cn(
                            'rounded-lg px-3 py-2 flex flex-col gap-1 text-left transition-colors',
                            isSelected
                              ? 'bg-[#E5E7EB] dark:bg-[#111827]'
                              : 'bg-white dark:bg-[#0C0C0C] hover:bg-[#F3F4F6] dark:hover:bg-[#18181b]'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                              {item.name}
                            </span>
                            <span
                              className={cn(
                                'text-[10px] font-mono px-2 py-0.5 rounded',
                                item.tag === 'Official'
                                  ? 'bg-[#22C55E]/20 text-[#16A34A] dark:text-[#22C55E]'
                                  : 'bg-[#3b82f6]/20 text-[#3b82f6]'
                              )}
                            >
                              {item.tag}
                            </span>
                          </div>
                          <span className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                            {item.description}
                          </span>
                          <span className="text-[10px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                            by {item.author}
                          </span>
                          {isInstalled && (
                            <span className="text-[10px] font-mono text-[#16A34A] dark:text-[#22C55E]">
                              Installed
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              </>
            )}

            {tab === 'repo' && (
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                  GitHub URL
                </span>
                <input
                  aria-label="Skill repository URL"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/org/skill"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:focus:border-[#27272a]"
                />
                <span className="inline-flex w-fit px-2 py-0.5 rounded bg-[#F3F4F6] dark:bg-[#18181b] text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                  Uses Git credentials available to the Blade process
                </span>
              </div>
            )}

            {tab === 'local' && (
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-mono text-[#6B7280] dark:text-[#a1a1aa]">
                  Local path
                </span>
                <input
                  aria-label="Local skill path"
                  value={localPath}
                  onChange={(event) => setLocalPath(event.target.value)}
                  placeholder="/Users/bytedance/skills/my-skill"
                  className="h-8 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] px-3 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono placeholder:text-[#9CA3AF] dark:placeholder:text-[#71717a] border border-transparent focus:outline-none focus:border-[#E5E7EB] dark:focus:border-[#27272a]"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => onOpenChange(false)}
              className="h-7 px-3 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={handleInstall}
              disabled={installDisabled}
              className={cn(
                'h-7 px-3 rounded-md text-[11px] font-mono font-semibold',
                installDisabled
                  ? 'bg-[#E5E7EB] text-[#9CA3AF] cursor-not-allowed dark:bg-[#27272a] dark:text-[#71717a]'
                  : 'bg-[#16A34A] text-white dark:bg-[#22C55E] dark:text-[#0C0C0C]'
              )}
            >
              Install
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillsInstallStatusModal({
  open,
  status,
  error,
  onCancel,
  onConfirm,
  onRetry,
}: {
  open: boolean;
  status: 'confirm' | 'installing' | 'failed';
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !next && onCancel()}>
      <DialogContent
        className="sm:max-w-[320px] p-0 overflow-hidden gap-0 bg-white dark:bg-[#09090b] border border-[#E5E7EB] dark:border-zinc-800 rounded-xl"
        aria-describedby={undefined}
        hideCloseButton
      >
        <DialogTitle className="sr-only">Install Status</DialogTitle>
        <div className="p-5 flex flex-col gap-3">
          {status === 'confirm' && (
            <>
              <h4 className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                Confirm Install
              </h4>
              <p className="text-[12px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                Install selected skill?
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onCancel}
                  className="h-6 px-2.5 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={onConfirm}
                  className="h-6 px-2.5 rounded-md bg-[#16A34A] text-white dark:bg-[#22C55E] dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
                >
                  Install
                </button>
              </div>
            </>
          )}

          {status === 'installing' && (
            <>
              <h4 className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                Installing
              </h4>
              <p className="text-[12px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                Downloading and verifying…
              </p>
              <div className="h-1.5 rounded-full bg-[#E5E7EB] dark:bg-[#18181b] overflow-hidden">
                <div className="h-full w-[45%] bg-[#16A34A] dark:bg-[#22C55E]" />
              </div>
              <span className="text-[11px] font-mono text-[#9CA3AF] dark:text-[#71717a]">
                ~35%
              </span>
              <button
                onClick={onCancel}
                className="self-end h-6 px-2.5 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
              >
                Hide
              </button>
            </>
          )}

          {status === 'failed' && (
            <>
              <h4 className="text-sm font-mono font-semibold text-[#111827] dark:text-[#E5E5E5]">
                Install Failed
              </h4>
              <p className="text-[12px] font-mono text-[#f87171]">
                {error || 'Installation failed.'}
              </p>
              <p className="text-[11px] font-mono text-[#6B7280] dark:text-[#94a3b8]">
                Check access and try again.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onCancel}
                  className="h-6 px-2.5 rounded-md bg-[#F3F4F6] dark:bg-[#18181b] text-[#111827] dark:text-[#E5E5E5] text-[11px] font-mono font-semibold"
                >
                  Close
                </button>
                <button
                  onClick={onRetry}
                  className="h-6 px-2.5 rounded-md bg-[#16A34A] text-white dark:bg-[#22C55E] dark:text-[#0C0C0C] text-[11px] font-mono font-semibold"
                >
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
