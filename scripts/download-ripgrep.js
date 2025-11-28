#!/usr/bin/env node

/**
 * 下载所有平台的 ripgrep 二进制文件到 vendor 目录
 * 使用: node scripts/download-ripgrep.js [版本号]
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { get } from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// 配置
const VERSION = process.argv[2] || '14.1.0';
const BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}`;
const VENDOR_DIR = join(PROJECT_ROOT, 'vendor', 'ripgrep');

// 平台映射
const PLATFORMS = [
  {
    name: 'macOS (Apple Silicon)',
    rgPlatform: 'x86_64-apple-darwin',
    bladePlatform: 'darwin-x64',
    binary: 'rg',
    archive: 'tar.gz',
  },
  {
    name: 'macOS (Intel)',
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
    rgPlatform: 'aarch64-unknown-linux-gnu',
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

/**
 * 下载文件
 */
async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = createWriteStream(dest);
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
        process.stdout.write(`\r  进度: ${progress}%`);
      });

      pipeline(response, fileStream)
        .then(() => {
          console.log(''); // 新行
          resolve();
        })
        .catch(reject);
    }).on('error', reject);
  });
}

/**
 * 解压 tar.gz 文件
 */
async function extractTarGz(archivePath, targetDir, fileName) {
  const { promisify } = await import('util');
  const { exec } = await import('child_process');
  const execAsync = promisify(exec);

  const archiveBaseName = `ripgrep-${VERSION}-${fileName}`;
  const cmd = `tar -xzf "${archivePath}" --strip-components=1 -C "${targetDir}" "${archiveBaseName}/rg"`;

  try {
    await execAsync(cmd);
  } catch (error) {
    throw new Error(`解压失败: ${error.message}`);
  }
}

/**
 * 解压 zip 文件
 */
async function extractZip(archivePath, targetDir, fileName) {
  const { promisify } = await import('util');
  const { exec } = await import('child_process');
  const execAsync = promisify(exec);

  const archiveBaseName = `ripgrep-${VERSION}-${fileName}`;
  const cmd = `unzip -j -o "${archivePath}" "${archiveBaseName}/rg.exe" -d "${targetDir}"`;

  try {
    await execAsync(cmd);
  } catch (error) {
    throw new Error(`解压失败: ${error.message}`);
  }
}

/**
 * 获取文件大小（人类可读）
 */
function getHumanFileSize(filePath) {
  const stats = statSync(filePath);
  const bytes = stats.size;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * 列出所有下载的文件
 */
function listDownloadedFiles() {
  const files = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === 'rg' || entry.name === 'rg.exe') {
        files.push(fullPath);
      }
    }
  }

  if (existsSync(VENDOR_DIR)) {
    walk(VENDOR_DIR);
  }

  return files;
}

/**
 * 主函数
 */
async function main() {
  console.log(`📦 开始下载 ripgrep v${VERSION} 所有平台的二进制文件...\n`);

  // 创建 vendor 目录
  if (!existsSync(VENDOR_DIR)) {
    mkdirSync(VENDOR_DIR, { recursive: true });
  }

  // 下载每个平台
  for (const platform of PLATFORMS) {
    console.log(`\n⏬ 正在下载 ${platform.name} (${platform.bladePlatform})...`);

    const archiveName = `ripgrep-${VERSION}-${platform.rgPlatform}.${platform.archive}`;
    const downloadUrl = `${BASE_URL}/${archiveName}`;
    const tempFile = join('/tmp', archiveName);
    const targetDir = join(VENDOR_DIR, platform.bladePlatform);

    try {
      // 创建目标目录
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // 下载文件
      console.log(`  URL: ${downloadUrl}`);
      await downloadFile(downloadUrl, tempFile);

      // 解压文件
      console.log(`  📂 正在解压到 ${targetDir}...`);
      if (platform.archive === 'tar.gz') {
        await extractTarGz(tempFile, targetDir, platform.rgPlatform);
      } else if (platform.archive === 'zip') {
        await extractZip(tempFile, targetDir, platform.rgPlatform);
      }

      // 设置执行权限（Unix 平台）
      if (platform.binary === 'rg') {
        const binaryPath = join(targetDir, platform.binary);
        try {
          chmodSync(binaryPath, 0o755);
        } catch (error) {
          console.warn(`  ⚠️  无法设置执行权限: ${error.message}`);
        }
      }

      console.log(`  ✅ ${platform.name} 下载完成`);
    } catch (error) {
      console.error(`  ❌ ${platform.name} 下载失败: ${error.message}`);
    }
  }

  // 显示总结
  console.log(`\n🎉 所有平台的 ripgrep 二进制文件下载完成！\n`);
  console.log('📍 文件位置:');

  const files = listDownloadedFiles();
  for (const file of files) {
    const size = getHumanFileSize(file);
    console.log(`  - ${file} (${size})`);
  }

  console.log('\n💡 提示: 这些文件将被包含在 npm 包中，确保它们有正确的权限。');
}

// 运行
main().catch((error) => {
  console.error(`\n❌ 发生错误: ${error.message}`);
  process.exit(1);
});
