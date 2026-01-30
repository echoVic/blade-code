/**
 * packageInfo 单元测试
 */

import { describe, expect, it } from 'vitest';
import {
  getCopyright,
  getDescription,
  getFormattedVersion,
  getPackageInfo,
  getPackageName,
  getVersion,
} from '../../../src/utils/packageInfo.js';

describe('packageInfo', () => {
  it('getPackageInfo 应返回完整的包信息', () => {
    const info = getPackageInfo();
    expect(info).toHaveProperty('name');
    expect(info).toHaveProperty('version');
    expect(info).toHaveProperty('description');
    expect(typeof info.name).toBe('string');
    expect(typeof info.version).toBe('string');
  });

  it('getVersion 应返回版本号', () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('getPackageName 应返回包名', () => {
    const name = getPackageName();
    expect(name).toBe('blade-code');
  });

  it('getDescription 应返回描述', () => {
    const desc = getDescription();
    expect(desc).toContain('Blade Code');
  });

  it('getFormattedVersion 应返回带 v 前缀的版本号', () => {
    const formatted = getFormattedVersion();
    expect(formatted).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('getCopyright 应返回版权信息', () => {
    const copyright = getCopyright();
    expect(copyright).toContain('©');
    expect(copyright).toContain('Blade Code');
  });
});
