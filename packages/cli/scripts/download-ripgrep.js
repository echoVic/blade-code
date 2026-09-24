#!/usr/bin/env node

/**
 * 下载所有平台的 ripgrep 二进制文件到 vendor 目录，并用官方 .sha256 校验
 * 使用: node scripts/download-ripgrep.js [版本号]
 * 环境变量 RIPGREP_DOWNLOAD_BASE_URL 可替换下载源（如镜像）
 * 任一平台失败即以非零退出，避免发布缺少二进制的包
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 配置
const VERSION = process.argv[2] || '15.2.0';
const BASE_URL = `${
  process.env.RIPGREP_DOWNLOAD_BASE_URL ||
  'https://github.com/BurntSushi/ripgrep/releases/download'
}/${VERSION}`;
const VENDOR_DIR = join(PROJECT_ROOT, 'vendor', 'ripgrep');

// 平台映射
const PLATFORMS = [
  {
    name: 'macOS (Intel)',
    rgPlatform: 'x86_64-apple-darwin',
    bladePlatform: 'darwin-x64',
    binary: 'rg',
    archive: 'tar.gz',
  },
  {
    name: 'macOS (Apple Silicon)',
    rgPlatform: 'aarch64-apple-darwin',
    bladePlatform: 'darwin-arm64',
    binary: 'rg',
    archive: 'tar.gz',
  },
  {
    name: 'Linux (x64)',
    rgPlatform: 'x86_64-unknown-linux-musl',
    bladePlatform: 'linux-x64',
    binary: 'rg',
    archive: 'tar.gz',
  },
  {
    name: 'Linux (ARM64)',
    // 静态链接的 musl 版本，glibc 与 musl 发行版都能运行
    rgPlatform: 'aarch64-unknown-linux-musl',
    bladePlatform: 'linux-arm64',
    binary: 'rg',
    archive: 'tar.gz',
  },
  {
    name: 'Windows (x64)',
    rgPlatform: 'x86_64-pc-windows-msvc',
    bladePlatform: 'win32-x64',
    binary: 'rg.exe',
    archive: 'zip',
  },
];

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** 官方校验文件有 `hash  name` 与 Windows CertUtil 两种格式，均取其中的 64 位十六进制摘要 */
async function fetchExpectedSha256(url) {
  const hash = (await fetchBuffer(url)).toString('utf8').match(/\b[0-9a-f]{64}\b/i)?.[0];
  if (!hash) {
    throw new Error(`校验文件中没有 SHA256: ${url}`);
  }
  return hash.toLowerCase();
}

/** 校验通过后才解压并覆盖，失败时保留原有二进制 */
async function installPlatform(platform, workDir) {
  const archiveBaseName = `ripgrep-${VERSION}-${platform.rgPlatform}`;
  const archiveName = `${archiveBaseName}.${platform.archive}`;
  const url = `${BASE_URL}/${archiveName}`;
  console.log(`  URL: ${url}`);

  const [archive, expected] = await Promise.all([
    fetchBuffer(url),
    fetchExpectedSha256(`${url}.sha256`),
  ]);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new Error(`SHA256 不匹配: 期望 ${expected}，实际 ${actual}`);
  }

  const archivePath = join(workDir, archiveName);
  const memberPath = `${archiveBaseName}/${platform.binary}`;
  writeFileSync(archivePath, archive);
  if (platform.archive === 'zip') {
    await execFileAsync('unzip', ['-o', '-q', archivePath, memberPath, '-d', workDir]);
  } else {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', workDir, memberPath]);
  }

  const targetDir = join(VENDOR_DIR, platform.bladePlatform);
  const binaryPath = join(targetDir, platform.binary);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(workDir, memberPath), binaryPath);
  if (platform.binary === 'rg') {
    chmodSync(binaryPath, 0o755);
  }
  return binaryPath;
}

async function main() {
  console.log(`📦 开始下载 ripgrep v${VERSION} 所有平台的二进制文件...\n`);

  const workDir = mkdtempSync(join(tmpdir(), 'blade-ripgrep-'));
  const failures = [];
  try {
    for (const platform of PLATFORMS) {
      console.log(`⏬ ${platform.name} (${platform.bladePlatform})`);
      try {
        const binaryPath = await installPlatform(platform, workDir);
        const size = (statSync(binaryPath).size / 1024 / 1024).toFixed(2);
        console.log(`  ✅ ${binaryPath} (${size} MB)`);
      } catch (error) {
        failures.push(platform.name);
        console.error(`  ❌ ${error.message}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} 个平台失败: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\n🎉 ripgrep v${VERSION} 已校验并写入 ${VENDOR_DIR}`);
}

main().catch((error) => {
  console.error(`\n❌ 发生错误: ${error.message}`);
  process.exit(1);
});
