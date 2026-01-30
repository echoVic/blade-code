/**
 * 版本检查服务
 *
 * 启动时检查 npm registry 获取最新版本，提供交互式更新选项
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import semver from 'semver';
import { fileURLToPath } from 'url';
import { proxyFetch } from '../utils/proxyFetch.js';

// 包名
const PACKAGE_NAME = 'blade-code';

// Changelog URL (via jsDelivr CDN, supports UTF-8)
const CHANGELOG_URL = 'https://cdn.jsdelivr.net/npm/blade-code@latest/CHANGELOG.md';

// 缓存文件路径
const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.blade'
);
const CACHE_FILE = path.join(CACHE_DIR, 'version-cache.json');

// 缓存有效期：1 小时
const CACHE_TTL = 1 * 60 * 60 * 1000;

// npm registry URL
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface VersionCache {
  latestVersion: string;
  checkedAt: number;
  skipUntilVersion?: string; // 跳过直到此版本
}

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  shouldPrompt: boolean; // 是否应该显示提示（考虑 skip 设置）
  releaseNotesUrl: string;
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
    // 保留 skipUntilVersion 但标记版本缓存过期
    return { ...cache, checkedAt: 0 };
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 */
async function writeCache(cache: VersionCache): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o755 });
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
    const response = await proxyFetch(NPM_REGISTRY_URL, {
      timeout: 5000, // 5 秒超时
      headers: {
        Accept: 'application/json',
      },
    });

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
 * 检查版本更新
 *
 * @param forceCheck - 强制检查（忽略缓存）
 * @returns 版本检查结果
 */
export async function checkVersion(forceCheck = false): Promise<VersionCheckResult> {
  const currentVersion = await getCurrentVersion();
  const releaseNotesUrl = CHANGELOG_URL;

  // 如果无法获取当前版本，跳过检查
  if (currentVersion === 'unknown') {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      shouldPrompt: false,
      releaseNotesUrl,
      error: 'Unable to determine current version',
    };
  }

  // 读取缓存
  const cache = await readCache();
  const skipUntilVersion = cache?.skipUntilVersion;

  // 尝试从缓存读取版本
  let latestVersion: string | null = null;
  if (!forceCheck && cache && cache.checkedAt > 0) {
    latestVersion = cache.latestVersion;
  } else {
    // 从 npm 获取最新版本
    latestVersion = await fetchLatestVersion();

    if (latestVersion) {
      // 更新缓存（保留 skipUntilVersion）
      await writeCache({
        latestVersion,
        checkedAt: Date.now(),
        skipUntilVersion,
      });
    }
  }

  if (!latestVersion) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      shouldPrompt: false,
      releaseNotesUrl,
      error: 'Unable to check for updates',
    };
  }

  const hasUpdate = semver.gt(latestVersion, currentVersion);

  // 检查是否应该跳过此版本的提示
  let shouldPrompt = hasUpdate;
  if (hasUpdate && skipUntilVersion) {
    // 如果 latestVersion > skipUntilVersion，说明有新版本，应该显示提示
    // 如果 latestVersion <= skipUntilVersion，说明用户选择跳过，不显示提示
    shouldPrompt = semver.gt(latestVersion, skipUntilVersion);
  }

  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    shouldPrompt,
    releaseNotesUrl,
  };
}

/**
 * 设置跳过直到下一版本
 */
export async function setSkipUntilVersion(version: string): Promise<void> {
  const cache = await readCache();
  await writeCache({
    latestVersion: cache?.latestVersion || version,
    checkedAt: cache?.checkedAt || Date.now(),
    skipUntilVersion: version,
  });
}

/**
 * 执行升级
 * @returns 升级命令
 */
export function getUpgradeCommand(): string {
  // 指定官方 registry 确保获取最新版本，避免镜像源同步延迟问题
  return `npm install -g ${PACKAGE_NAME}@latest --registry https://registry.npmjs.org`;
}

/**
 * 执行升级（返回 Promise）
 */
export async function performUpgrade(): Promise<{ success: boolean; message: string }> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const command = getUpgradeCommand();

    const child = spawn(command, {
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          message: '✅ 升级成功！请重新启动 blade。',
        });
      } else {
        resolve({
          success: false,
          message: `❌ 升级失败 (exit code: ${code})`,
        });
      }
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        message: `❌ 升级失败: ${error.message}`,
      });
    });
  });
}

/**
 * 启动时版本检查（简化版，仅返回检查结果）
 */
export async function checkVersionOnStartup(): Promise<VersionCheckResult | null> {
  try {
    const result = await checkVersion();
    return result.shouldPrompt ? result : null;
  } catch {
    return null;
  }
}
