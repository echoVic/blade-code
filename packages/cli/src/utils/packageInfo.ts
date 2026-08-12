/**
 * Package.json 信息读取工具
 * 提供统一的包信息访问接口
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json';

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
}

let cachedPackageInfo: PackageInfo | undefined;

function readRuntimePackageInfo(): PackageInfo {
  if (cachedPackageInfo) return cachedPackageInfo;

  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const candidate = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8')
      ) as Partial<PackageInfo>;
      if (
        candidate.name === packageJson.name &&
        typeof candidate.version === 'string' &&
        typeof candidate.description === 'string'
      ) {
        cachedPackageInfo = candidate as PackageInfo;
        return cachedPackageInfo;
      }
    } catch {
      // Source and bundled layouts place package.json at different depths.
    }
    directory = dirname(directory);
  }

  cachedPackageInfo = {
    name: packageJson.name,
    version: process.env.BLADE_VERSION ?? packageJson.version,
    description: packageJson.description,
  };
  return cachedPackageInfo;
}

/**
 * 获取包信息
 */
export function getPackageInfo(): PackageInfo {
  return { ...readRuntimePackageInfo() };
}

/**
 * 获取版本号
 */
export function getVersion(): string {
  return readRuntimePackageInfo().version;
}

/**
 * 获取包名
 */
export function getPackageName(): string {
  return readRuntimePackageInfo().name;
}

/**
 * 获取描述
 */
export function getDescription(): string {
  return readRuntimePackageInfo().description;
}

/**
 * 获取格式化的版本信息
 */
export function getFormattedVersion(): string {
  return `v${getVersion()}`;
}

/**
 * 获取版权信息
 */
export function getCopyright(): string {
  return `v${getVersion()} © 2025 Blade Code`;
}
