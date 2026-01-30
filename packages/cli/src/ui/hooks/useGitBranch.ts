import { useEffect, useState } from 'react';
import { getCurrentBranch, isGitRepository } from '../../utils/git.js';

export interface GitBranchInfo {
  /** 当前分支名，非 Git 仓库时为 null */
  branch: string | null;
  /** 是否正在加载 */
  loading: boolean;
}

/**
 * 获取当前 Git 分支的 hook
 *
 * @param cwd - 工作目录，默认为 process.cwd()
 * @param refreshInterval - 刷新间隔(毫秒)，默认 5000ms，设为 0 禁用自动刷新
 * @returns Git 分支信息
 */
export function useGitBranch(
  cwd: string = process.cwd(),
  refreshInterval: number = 5000
): GitBranchInfo {
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchBranch = async () => {
      try {
        // 先检查是否是 Git 仓库
        const isRepo = await isGitRepository(cwd);
        if (!mounted) return;

        if (!isRepo) {
          setBranch(null);
          setLoading(false);
          return;
        }

        // 获取当前分支
        const currentBranch = await getCurrentBranch(cwd);
        if (!mounted) return;

        setBranch(currentBranch);
      } catch {
        if (mounted) {
          setBranch(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    // 初始获取
    fetchBranch();

    // 定时刷新（如果启用）
    let intervalId: NodeJS.Timeout | null = null;
    if (refreshInterval > 0) {
      intervalId = setInterval(fetchBranch, refreshInterval);
    }

    return () => {
      mounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [cwd, refreshInterval]);

  return { branch, loading };
}
