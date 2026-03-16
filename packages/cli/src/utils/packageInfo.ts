/**
 * Package.json 信息读取工具
 * 提供统一的包信息访问接口
 *
 * 注意：为兼容纯 Node ESM 运行环境，这里不再使用对 package.json 的静态 import，
 * 而是通过 fs 读取并解析 JSON，避免对 `import ... assert { type: "json" }` 的依赖。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let packageJsonPath = path.resolve(__dirname, '../../../package.json');
try {
  readFileSync(packageJsonPath, 'utf8');
} catch (e) {
  try {
    packageJsonPath = path.resolve(__dirname, '../../package.json');
    readFileSync(packageJsonPath, 'utf8');
  } catch (e2) {
    packageJsonPath = path.resolve(__dirname, '../package.json');
  }
}
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  name: string;
  version: string;
  description: string;
};

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
}

/**
 * 获取包信息
 */
export function getPackageInfo(): PackageInfo {
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
  };
}

/**
 * 获取版本号
 */
export function getVersion(): string {
  return packageJson.version;
}

/**
 * 获取包名
 */
export function getPackageName(): string {
  return packageJson.name;
}

/**
 * 获取描述
 */
export function getDescription(): string {
  return packageJson.description;
}

/**
 * 获取格式化的版本信息
 */
export function getFormattedVersion(): string {
  return `v${packageJson.version}`;
}

/**
 * 获取版权信息
 */
export function getCopyright(): string {
  return `v${packageJson.version} © 2025 Blade Code`;
}
