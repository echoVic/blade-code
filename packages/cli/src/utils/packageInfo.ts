/**
 * Package.json 信息读取工具
 * 提供统一的包信息访问接口
 */

import packageJson from '../../package.json';

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
