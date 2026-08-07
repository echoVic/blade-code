import { FileText, Folder, FolderOpen, Loader2, RotateCcw } from 'lucide-react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

export interface PreviewTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: PreviewTreeNode[];
}

export type DirectoryLoadState =
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'error'; message: string };

interface PreviewFileTreeProps {
  nodes: PreviewTreeNode[];
  expandedDirs: Record<string, boolean>;
  childrenCache: Record<string, PreviewTreeNode[]>;
  directoryStates: Record<string, DirectoryLoadState>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onRetryDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}

export function PreviewFileTree({
  nodes,
  expandedDirs,
  childrenCache,
  directoryStates,
  selectedPath,
  onToggleDir,
  onRetryDir,
  onSelectFile,
}: PreviewFileTreeProps) {
  return (
    <>
      {nodes.map((node) => (
        <PreviewFileTreeNode
          key={node.path}
          node={node}
          depth={0}
          expandedDirs={expandedDirs}
          childrenCache={childrenCache}
          directoryStates={directoryStates}
          selectedPath={selectedPath}
          onToggleDir={onToggleDir}
          onRetryDir={onRetryDir}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

function PreviewFileTreeNode({
  node,
  depth,
  expandedDirs,
  childrenCache,
  directoryStates,
  selectedPath,
  onToggleDir,
  onRetryDir,
  onSelectFile,
}: Omit<PreviewFileTreeProps, 'nodes'> & {
  node: PreviewTreeNode;
  depth: number;
}) {
  const t = useT();
  const isDir = node.type === 'dir';
  const isExpanded = Boolean(expandedDirs[node.path]);
  const isSelected = !isDir && selectedPath === node.path;
  const children = childrenCache[node.path] ?? [];
  const state = directoryStates[node.path];
  const childInset = depth * 14 + 24;

  return (
    <div>
      <button
        type="button"
        aria-expanded={isDir ? isExpanded : undefined}
        aria-busy={isDir && state?.status === 'loading'}
        onClick={() => (isDir ? onToggleDir(node.path) : onSelectFile(node.path))}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] transition-colors',
          isSelected
            ? 'border border-[#16A34A]/30 bg-[#16A34A]/10 text-[#111827] dark:border-[#22C55E]/30 dark:bg-[#22C55E]/10 dark:text-[#E5E5E5]'
            : 'text-[hsl(var(--deck-ink-muted))] hover:bg-[hsl(var(--deck-surface))]',
          isDir && 'cursor-pointer'
        )}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {isDir ? (
          state?.status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
          ) : isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink))]" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-muted))]" />
          )
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
        )}
        <span className="truncate text-[hsl(var(--deck-ink))]">{node.name}</span>
      </button>

      {isDir && isExpanded && (
        <div>
          {state?.status === 'loading' && (
            <div
              role="status"
              style={{ paddingLeft: childInset }}
              className="py-1 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]"
            >
              {t('preview.files.directoryLoading')}
            </div>
          )}
          {state?.status === 'error' && (
            <div
              role="alert"
              style={{ marginLeft: childInset }}
              className="my-1 mr-1 rounded-md border border-red-200 bg-red-50/70 px-2 py-1.5 font-mono text-[10px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              <div className="truncate" title={state.message}>
                {state.message}
              </div>
              <button
                type="button"
                onClick={() => onRetryDir(node.path)}
                className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
              >
                <RotateCcw className="h-2.5 w-2.5" />
                {t('preview.action.retry')}
              </button>
            </div>
          )}
          {state?.status === 'loaded' && children.length === 0 && (
            <div
              style={{ paddingLeft: childInset }}
              className="py-1 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]"
            >
              {t('preview.files.directoryEmpty')}
            </div>
          )}
          {children.map((child) => (
            <PreviewFileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              childrenCache={childrenCache}
              directoryStates={directoryStates}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onRetryDir={onRetryDir}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
