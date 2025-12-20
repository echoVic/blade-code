/**
 * 版本检查服务
 *
 * 启动时检查 npm registry 获取最新版本，提示用户更新
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 包名
const PACKAGE_NAME = 'blade-code';

// 缓存文件路径
const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.blade'
);
const CACHE_FILE = path.join(CACHE_DIR, 'version-cache.json');

// 缓存有效期：1 小时
const CACHE_TTL = 1 * 60 * 60 * 1000;

// npm registry URL
const NPM_REGISTRY_URL = `https://registry.npmmirror.com/${PACKAGE_NAME}/latest`;

interface VersionCache {
  latestVersion: string;
  checkedAt: number;
}

interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  error?: string;
}

/**
 * 获取当前安装的版本
 */
async function getCurrentVersion(): Promise<string> {
  try {
    // 方法1：从环境变量获取（构建时注入）
    if (process.env.BLADE_VERSION) {
      return process.env.BLADE_VERSION;
    }

    // 方法2：从 package.json 获取
    // 获取当前模块的目录
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // 尝试多个可能的 package.json 位置
    const possiblePaths = [
      path.join(__dirname, '..', '..', 'package.json'), // src/services -> root
      path.join(__dirname, '..', 'package.json'), // dist -> root
      path.join(process.cwd(), 'package.json'), // 当前工作目录
    ];

    for (const pkgPath of possiblePaths) {
      try {
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        if (pkg.name === PACKAGE_NAME && pkg.version) {
          return pkg.version;
        }
      } catch {
        // 继续尝试下一个路径
      }
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 从缓存读取版本信息
 */
async function readCache(): Promise<VersionCache | null> {
  try {
    const content = await fs.readFile(CACHE_FILE, 'utf-8');
    const cache: VersionCache = JSON.parse(content);

    // 检查缓存是否过期
    if (Date.now() - cache.checkedAt < CACHE_TTL) {
      return cache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 */
async function writeCache(cache: VersionCache): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // 静默失败
  }
}

/**
 * 从 npm registry 获取最新版本
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 秒超时

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * 比较版本号
 * 返回: 1 如果 a > b, -1 如果 a < b, 0 如果相等
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;

    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  return 0;
}

/**
 * 检查版本更新
 *
 * @param forceCheck - 强制检查（忽略缓存）
 * @returns 版本检查结果
 */
export async function checkVersion(forceCheck = false): Promise<VersionCheckResult> {
  const currentVersion = await getCurrentVersion();

  // 如果无法获取当前版本，跳过检查
  if (currentVersion === 'unknown') {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      error: 'Unable to determine current version',
    };
  }

  // 尝试从缓存读取
  if (!forceCheck) {
    const cache = await readCache();
    if (cache) {
      return {
        currentVersion,
        latestVersion: cache.latestVersion,
        hasUpdate: compareVersions(cache.latestVersion, currentVersion) > 0,
      };
    }
  }

  // 从 npm 获取最新版本
  const latestVersion = await fetchLatestVersion();

  if (latestVersion) {
    // 更新缓存
    await writeCache({
      latestVersion,
      checkedAt: Date.now(),
    });

    return {
      currentVersion,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    };
  }

  return {
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    error: 'Unable to check for updates',
  };
}

/**
 * 格式化版本更新提示消息
 */
export function formatUpdateMessage(result: VersionCheckResult): string | null {
  if (!result.hasUpdate || !result.latestVersion) {
    return null;
  }

  return (
    `\x1b[33m⚠️  Update available: ${result.currentVersion} → ${result.latestVersion}\x1b[0m\n` +
    `   Run \x1b[36mnpm install -g ${PACKAGE_NAME}@latest\x1b[0m to update`
  );
}

/**
 * 执行自动升级（后台进程，不阻塞主进程）
 * @returns 升级提示消息
 */
async function performUpgrade(
  currentVersion: string,
  latestVersion: string
): Promise<string> {
  const { spawn } = await import('child_process');

  try {
    const updateCommand = `npm install -g blade-code@${latestVersion} --registry https://registry.npmjs.org`;

    // 使用 spawn + detached + unref 在后台运行升级
    // 这样主进程退出后，升级进程会继续运行完成安装
    const updateProcess = spawn(updateCommand, {
      stdio: 'ignore',
      shell: true,
      detached: true,
    });
    updateProcess.unref();

    return `⬆️ 正在后台升级 ${currentVersion} → ${latestVersion}，下次启动生效`;
  } catch {
    return (
      `\x1b[33m⚠️  Update available: ${currentVersion} → ${latestVersion}\x1b[0m\n` +
      `   Run \x1b[36mnpm install -g ${PACKAGE_NAME}@latest\x1b[0m to update`
    );
  }
}

/**
 * 启动时版本检查并自动升级
 *
 * @param autoUpgrade - 是否自动升级（默认 true）
 * @returns Promise<string | null> 提示消息，如果没有更新则返回 null
 */
export async function checkVersionOnStartup(
  autoUpgrade = true
): Promise<string | null> {
  try {
    const result = await checkVersion();

    if (!result.hasUpdate || !result.latestVersion) {
      return null;
    }

    // 自动升级
    if (autoUpgrade) {
      return await performUpgrade(result.currentVersion, result.latestVersion);
    }

    // 仅显示提示
    return formatUpdateMessage(result);
  } catch {
    return null;
  }
}
