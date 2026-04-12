#!/usr/bin/env node

import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const monorepoRoot = join(__dirname, '../../..');
const packageJsonPath = join(rootDir, 'package.json');
const configPath = join(rootDir, 'release.config.js');

// 加载配置
let config = {};
if (existsSync(configPath)) {
  const configModule = await import(configPath);
  config = configModule.default || {};
}

// 解析命令行参数
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const releaseType = args.find(arg => ['--major', '--minor', '--patch'].includes(arg))?.replace('--', '') || config.version?.defaultType || 'patch';
const skipTests = args.includes('--skip-tests');
const skipBuild = args.includes('--skip-build');

// 读取当前 package.json
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;

// 检测包管理器类型
const packageManager = existsSync(join(monorepoRoot, 'bun.lock')) ? 'bun' :
                      existsSync(join(monorepoRoot, 'pnpm-lock.yaml')) ? 'pnpm' :
                      existsSync(join(monorepoRoot, 'yarn.lock')) ? 'yarn' : 'npm';

console.log(chalk.blue('🚀 Blade AI 发包脚本'));
console.log(chalk.gray(`当前版本: ${currentVersion}`));
console.log(chalk.gray(`发布类型: ${releaseType}`));
console.log(chalk.gray(`使用包管理器: ${packageManager}`));
if (isDryRun) {
  console.log(chalk.yellow('🏃 预演模式 (不会实际发布)'));
}

/**
 * 执行命令并返回输出
 */
function exec(command, options = {}) {
  if (isDryRun && !options.allowInDryRun) {
    console.log(chalk.cyan(`[DRY RUN] ${command}`));
    return '';
  }
  
  try {
    return execSync(command, { 
      encoding: 'utf8', 
      cwd: rootDir,
      stdio: 'pipe',
      ...options 
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return null;
    }
    throw error;
  }
}

function scriptCommand(scriptName) {
  switch (packageManager) {
    case 'bun':
    case 'pnpm':
    case 'npm':
    case 'yarn':
      return `${packageManager} run ${scriptName}`;
    default:
      return `${packageManager} run ${scriptName}`;
  }
}

/**
 * 检查是否有未提交的更改
 */
function checkWorkingDirectory() {
  if (!config.preChecks?.checkWorkingDirectory) {
    console.log(chalk.gray('跳过工作目录检查'));
    return;
  }
  
  console.log(chalk.yellow('📋 检查工作目录...'));
  
  const status = exec('git status --porcelain', { allowInDryRun: true });
  if (status) {
    console.log(chalk.red('❌ 工作目录有未提交的更改:'));
    console.log(status);
    console.log(chalk.yellow('💡 请先提交或暂存更改'));
    if (!isDryRun) {
      process.exit(1);
    }
  }
  
  console.log(chalk.green('✅ 工作目录干净'));
}

/**
 * 检查代码质量
 */
function checkCodeQuality() {
  if (!config.preChecks?.checkCodeQuality) {
    console.log(chalk.gray('跳过代码质量检查'));
    return;
  }
  
  console.log(chalk.yellow('🔍 检查代码质量...'));
  
  try {
    if (packageJson.scripts?.check) {
      exec(scriptCommand('check'));
      console.log(chalk.green('✅ 代码质量检查通过'));
    } else {
      console.log(chalk.gray('未找到 check 脚本，跳过'));
    }
  } catch (error) {
    console.log(chalk.red('❌ 代码质量检查失败'));
    throw error;
  }
}

/**
 * 同步远程 tags
 */
function fetchTags() {
  console.log(chalk.yellow('🔄 同步远程 tags...'));
  try {
    exec('git fetch --tags', { allowInDryRun: true });
    console.log(chalk.green('✅ Tags 已同步'));
  } catch (error) {
    console.log(chalk.yellow('⚠️ 无法同步远程 tags，使用本地 tags'));
  }
}

/**
 * 获取最新的 git tags
 */
function getLatestTag() {
  const tagPrefix = config.version?.tagPrefix || 'v';
  const tag = exec('git describe --tags --abbrev=0', { allowFailure: true, allowInDryRun: true });
  return tag || `${tagPrefix}0.0.0`;
}

/**
 * 检查远程 npm 包版本
 */
async function checkNpmVersion() {
  console.log(chalk.yellow('📦 检查 npm 远程版本...'));
  
  try {
    const npmInfo = exec(`npm view ${packageJson.name} version`, { allowFailure: true, allowInDryRun: true });
    if (npmInfo) {
      console.log(chalk.gray(`远程版本: ${npmInfo}`));
      return npmInfo;
    } else {
      console.log(chalk.gray('包尚未发布到 npm'));
      return null;
    }
  } catch (error) {
    console.log(chalk.gray('无法获取远程版本信息'));
    return null;
  }
}

/**
 * 版本号比较
 */
function compareVersions(v1, v2) {
  const tagPrefix = config.version?.tagPrefix || 'v';
  const parts1 = v1.replace(new RegExp(`^${tagPrefix}`), '').split('.').map(Number);
  const parts2 = v2.replace(new RegExp(`^${tagPrefix}`), '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * 递增版本号
 */
function incrementVersion(version, type = 'patch') {
  const tagPrefix = config.version?.tagPrefix || 'v';
  const cleanVersion = version.replace(new RegExp(`^${tagPrefix}`), '');
  const parts = cleanVersion.split('.').map(Number);
  
  switch (type) {
    case 'major':
      parts[0]++;
      parts[1] = 0;
      parts[2] = 0;
      break;
    case 'minor':
      parts[1]++;
      parts[2] = 0;
      break;
    case 'patch':
    default:
      parts[2]++;
      break;
  }
  
  return parts.join('.');
}

/**
 * 确定新版本号
 */
async function determineNewVersion() {
  console.log(chalk.yellow('🔍 确定新版本号...'));
  
  const tagPrefix = config.version?.tagPrefix || 'v';
  const latestTag = getLatestTag().replace(new RegExp(`^${tagPrefix}`), '');
  const npmVersion = await checkNpmVersion();
  
  console.log(chalk.gray(`Git 最新标签: ${latestTag}`));
  console.log(chalk.gray(`当前 package.json: ${currentVersion}`));
  
  // 找出最高版本
  let maxVersion = currentVersion;
  if (compareVersions(latestTag, maxVersion) > 0) {
    maxVersion = latestTag;
  }
  if (npmVersion && compareVersions(npmVersion, maxVersion) > 0) {
    maxVersion = npmVersion;
  }
  
  // 根据指定的发布类型递增版本
  const newVersion = incrementVersion(maxVersion, releaseType);
  
  console.log(chalk.green(`✅ 新版本号: ${newVersion}`));
  return newVersion;
}

/**
 * 生成 changelog
 * @returns {string} 本次生成的 changelog 内容
 */
function generateChangelog(newVersion) {
  if (!config.changelog?.generate) {
    console.log(chalk.gray('跳过 changelog 生成'));
    return '';
  }
  
  console.log(chalk.yellow('📝 生成 changelog...'));
  
  const latestTag = getLatestTag();
  const changelogPath = join(rootDir, config.changelog?.file || 'CHANGELOG.md');
  const categories = config.changelog?.categories || {
    feat: '✨ 新功能',
    fix: '🐛 问题修复',
    other: '🔧 其他更改'
  };
  
  try {
    let commitRange = `${latestTag}..HEAD`;
    const tagExists = exec(`git rev-parse --verify ${latestTag}`, { allowFailure: true, allowInDryRun: true });
    
    if (!tagExists) {
      commitRange = 'HEAD~10..HEAD';
      console.log(chalk.gray('未找到标签，使用最近的提交'));
    }
    
    const commits = exec(`git log ${commitRange} --pretty=format:"%h %s" --no-merges`, { allowInDryRun: true, allowFailure: true });
    
    if (!commits) {
      console.log(chalk.gray('没有新的提交'));
      return '';
    }
    
    const commitLines = commits.split('\n');
    const changes = {};
    
    Object.keys(categories).forEach(key => {
      changes[key] = [];
    });
    
    commitLines.forEach(line => {
      const [hash, ...messageParts] = line.split(' ');
      const message = messageParts.join(' ');
      
      let categorized = false;
      for (const [key, label] of Object.entries(categories)) {
        if (key === 'other') continue;
        if (message.match(new RegExp(`^${key}(\\(.+\\))?:`, 'i'))) {
          changes[key].push(`- ${message.replace(new RegExp(`^${key}(\\(.+\\))?:\\s*`, 'i'), '')} (${hash})`);
          categorized = true;
          break;
        }
      }
      
      if (!categorized) {
        changes.other = changes.other || [];
        changes.other.push(`- ${message} (${hash})`);
      }
    });
    
    const date = new Date().toISOString().split('T')[0];
    let changelogContent = `## [${newVersion}] - ${date}\n\n`;
    
    Object.entries(categories).forEach(([key, label]) => {
      if (changes[key] && changes[key].length > 0) {
        changelogContent += `### ${label}\n\n`;
        changelogContent += changes[key].join('\n') + '\n\n';
      }
    });
    
    if (isDryRun) {
      console.log(chalk.cyan('📋 预览 changelog 内容:'));
      console.log(changelogContent);
      return changelogContent;
    }
    
    let existingChangelog = '';
    if (existsSync(changelogPath)) {
      existingChangelog = readFileSync(changelogPath, 'utf8');
    } else {
      existingChangelog = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n';
    }
    
    const changelogLines = existingChangelog.split('\n');
    const insertIndex = changelogLines.findIndex(line => line.startsWith('## ['));
    
    if (insertIndex !== -1) {
      changelogLines.splice(insertIndex, 0, changelogContent);
    } else {
      changelogLines.push(changelogContent);
    }
    
    writeFileSync(changelogPath, changelogLines.join('\n'));
    console.log(chalk.green('✅ Changelog 已更新'));

    const bladeDocPathEnv = process.env.BLADE_DOC_PATH;
    const defaultBladeDocPath = join(rootDir, '../blade-doc');
    const bladeDocDir = bladeDocPathEnv || defaultBladeDocPath;
    const bladeDocChangelogPath = join(bladeDocDir, 'changelog.md');

    if (existsSync(bladeDocDir)) {
      writeFileSync(bladeDocChangelogPath, changelogLines.join('\n'));
      console.log(chalk.green(`✅ blade-doc changelog 已同步至: ${bladeDocChangelogPath}`));
    } else {
      console.log(chalk.gray(`⚠️ 未找到 blade-doc 仓库 (路径: ${bladeDocDir})，跳过同步`));
      console.log(chalk.gray('💡 提示: 可通过 BLADE_DOC_PATH 环境变量指定路径'));
    }

    return changelogContent;

  } catch (error) {
    console.log(chalk.yellow('⚠️  无法生成 changelog:', error.message));
    return '';
  }
}

/**
 * 更新 package.json 版本
 */
function updatePackageVersion(newVersion) {
  console.log(chalk.yellow('📦 更新 package.json...'));
  
  if (isDryRun) {
    console.log(chalk.cyan(`[DRY RUN] 将版本从 ${currentVersion} 更新到 ${newVersion}`));
    return;
  }
  
  packageJson.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  
  console.log(chalk.green('✅ package.json 已更新'));
}

/**
 * 构建项目
 */
function buildProject() {
  if (!config.build?.beforePublish || skipBuild) {
    console.log(chalk.gray('跳过项目构建'));
    return;
  }
  
  console.log(chalk.yellow('🔨 构建项目...'));
  
  try {
    const buildCommand = config.build?.command || scriptCommand('build');
    exec(buildCommand);
    console.log(chalk.green('✅ 项目构建成功'));
  } catch (error) {
    console.log(chalk.red('❌ 构建失败'));
    throw error;
  }
}

/**
 * 运行测试（如果有）
 */
function runTests() {
  if (!config.preChecks?.runTests || skipTests) {
    console.log(chalk.gray('跳过测试'));
    return;
  }
  
  console.log(chalk.yellow('🧪 运行测试...'));
  
  try {
    // 检查是否有测试脚本
    if (packageJson.scripts && packageJson.scripts.test && packageJson.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      exec(scriptCommand('test'));
      console.log(chalk.green('✅ 测试通过'));
    } else {
      console.log(chalk.gray('跳过测试 (无测试脚本)'));
    }
  } catch (error) {
    console.log(chalk.red('❌ 测试失败'));
    throw error;
  }
}

/**
 * 提交更改并创建标签
 */
function commitAndTag(newVersion) {
  console.log(chalk.yellow('📝 提交更改并创建标签...'));
  
  try {
    const tagPrefix = config.version?.tagPrefix || 'v';
    exec('git add .', { cwd: monorepoRoot });
    exec(`git commit -m "chore: release ${tagPrefix}${newVersion}"`, { cwd: monorepoRoot });
    exec(`git tag ${tagPrefix}${newVersion}`, { cwd: monorepoRoot });
    
    console.log(chalk.green(`✅ 已创建标签 ${tagPrefix}${newVersion}`));
  } catch (error) {
    console.log(chalk.red('❌ 提交失败'));
    throw error;
  }
}

/**
 * 发布到 npm
 */
function publishToNpm() {
  if (!config.publish?.npm) {
    console.log(chalk.gray('跳过 npm 发布'));
    return;
  }
  
  console.log(chalk.yellow('📦 发布到 npm...'));
  
  try {
    // 构建发布命令
    let publishCmd = 'npm publish --access public';
    if (config.publish?.npmConfig?.registry) {
      publishCmd += ` --registry ${config.publish.npmConfig.registry}`;
    }
    
    // 发布
    exec(publishCmd);
    
    console.log(chalk.green('✅ 已发布到 npm'));
  } catch (error) {
    console.log(chalk.red('❌ 发布失败'));
    // 如果发布失败，提示用户手动登录后重试
    console.log(chalk.yellow('💡 请手动登录 npm 后重试:'));
    console.log(chalk.yellow('   npm login --registry https://registry.npmjs.org/'));
    console.log(chalk.yellow('   npm publish --access public --registry https://registry.npmjs.org/'));
    
    throw new Error(`npm publish failed: ${error.message}`);
  }
}

/**
 * 推送到远程仓库
 */
function pushToRemote() {
  if (!config.publish?.git) {
    console.log(chalk.gray('跳过 git 推送'));
    return;
  }
  
  console.log(chalk.yellow('🚀 推送到远程仓库...'));
  
  try {
    if (config.publish?.gitConfig?.pushBranch !== false) {
      exec('git push', { cwd: monorepoRoot });
    }
    if (config.publish?.gitConfig?.pushTags !== false) {
      exec('git push --tags', { cwd: monorepoRoot });
    }
    
    console.log(chalk.green('✅ 已推送到远程仓库'));
  } catch (error) {
    console.log(chalk.red('❌ 推送失败'));
    throw error;
  }
}

/**
 * 发送 Discord 通知
 */
async function sendDiscordNotification(version, changelogContent, isSuccess = true) {
  const webhookUrl = config.notifications?.discord?.webhookUrl;
  if (!webhookUrl) {
    console.log(chalk.yellow('⚠️ 未配置 Discord Webhook URL'));
    return;
  }

  const tagPrefix = config.version?.tagPrefix || 'v';
  const color = isSuccess ? 0x00ff00 : 0xff0000;
  const title = isSuccess 
    ? `🚀 Blade ${tagPrefix}${version} 发布成功！` 
    : `❌ Blade ${tagPrefix}${version} 发布失败`;

  let cleanedChangelog = changelogContent
    ?.replace(/^## \[.*?\] - \d{4}-\d{2}-\d{2}\n+/, '')
    ?.trim() || '';
  
  const truncatedChangelog = cleanedChangelog.length > 4000 
    ? cleanedChangelog.substring(0, 4000) + '\n...(内容已截断)'
    : cleanedChangelog;

  const payload = {
    embeds: [{
      title,
      description: truncatedChangelog || '无更新内容',
      color,
      timestamp: new Date().toISOString(),
      footer: {
        text: `Blade AI - ${packageJson.name}`,
      },
      fields: [
        {
          name: '📦 NPM',
          value: `[查看包](https://www.npmjs.com/package/${packageJson.name})`,
          inline: true,
        },
        {
          name: '📚 文档',
          value: '[查看文档](https://echovic.github.io/blade-code/#/)',
          inline: true,
        },
      ],
    }],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(chalk.green('✅ Discord 通知已发送'));
    } else {
      const errorText = await response.text();
      console.log(chalk.yellow(`⚠️ Discord 通知发送失败: ${response.status} ${errorText}`));
    }
  } catch (error) {
    console.log(chalk.yellow('⚠️ Discord 通知发送失败:', error.message));
  }
}

/**
 * 发送通知
 */
async function sendNotification(type, data, changelogContent = '') {
  if (!config.notifications?.enabled) {
    return;
  }
  
  const template = config.notifications?.templates?.[type] || '';
  let message = template;
  
  // 替换模板变量
  Object.entries(data).forEach(([key, value]) => {
    message = message.replace(new RegExp(`{{${key}}}`, 'g'), value);
  });
  
  // 发送通知
  for (const method of (config.notifications?.methods || [])) {
    switch (method) {
      case 'console':
        if (type === 'success') {
          console.log(chalk.green(message));
        } else {
          console.log(chalk.red(message));
        }
        break;
      case 'discord':
        await sendDiscordNotification(data.version, changelogContent, type === 'success');
        break;
    }
  }
}

/**
 * 预发布检查 - 综合性项目检查
 */
function preReleaseCheck() {
  console.log(chalk.blue('\n🔍 预发布检查'));
  
  let allChecks = true;

  console.log(chalk.yellow('\n📋 基本信息检查'));
  
  // 检查 package.json 必要字段
  // 注意: 对于 CLI 工具，main 字段不是必需的，只需要 bin 字段
  const requiredFields = ['name', 'version', 'description', 'bin'];
  requiredFields.forEach(field => {
    if (packageJson[field]) {
      console.log(chalk.green(`✅ ${field}: ${typeof packageJson[field] === 'object' ? JSON.stringify(packageJson[field]) : packageJson[field]}`));
    } else {
      console.log(chalk.red(`❌ 缺少字段: ${field}`));
      allChecks = false;
    }
  });

  console.log(chalk.yellow('\n🔧 依赖检查'));

  // 检查依赖安全
  if (config.preChecks?.checkSecurity !== false) {
    try {
      const auditCommand = packageManager === 'bun'
        ? 'bun audit --audit-level=high'
        : `${packageManager} audit --audit-level=high`;
      exec(auditCommand, { allowInDryRun: true });
      console.log(chalk.green('✅ 依赖安全检查通过'));
    } catch (error) {
      console.log(chalk.red('❌ 发现高风险依赖问题'));
      if (!isDryRun) {
        allChecks = false;
      }
    }
  } else {
    console.log(chalk.gray('⏭️  跳过安全检查'));
  }

  // 检查过期依赖（设置超时避免卡住）
  try {
    const outdatedCmd = packageManager === 'bun' ? 'bun outdated --no-progress --quiet' :
                       packageManager === 'pnpm' ? 'pnpm outdated --format json' :
                       packageManager === 'yarn' ? 'yarn outdated --json' :
                       'npm outdated --json';
    const outdated = exec(outdatedCmd, { allowFailure: true, allowInDryRun: true, timeout: 10000 });
    if (outdated) {
      let packages;
      if (packageManager === 'bun') {
        const rows = outdated
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.startsWith('|') && !line.includes('Package') && !/^(\|[-\s]+)+\|$/.test(line));
        packages = {};
        rows.forEach((line) => {
          const cells = line
            .split('|')
            .map(cell => cell.trim())
            .filter(Boolean);
          if (cells.length >= 4) {
            packages[cells[0]] = { current: cells[1], latest: cells[3] };
          }
        });
      } else if (packageManager === 'pnpm') {
        // pnpm outdated 输出格式不同，需要特殊处理
        const lines = outdated.split('\n').filter(line => line.trim());
        packages = {};
        lines.forEach(line => {
          const match = line.match(/(\S+)\s+(\S+)\s+(\S+)/);
          if (match) {
            packages[match[1]] = { current: match[2], latest: match[3] };
          }
        });
      } else {
        packages = JSON.parse(outdated);
      }
      
      const count = Object.keys(packages).length;
      if (count > 0) {
        console.log(chalk.yellow(`⚠️  发现 ${count} 个过期依赖`));
        Object.entries(packages).slice(0, 3).forEach(([name, info]) => {
          console.log(chalk.gray(`  ${name}: ${info.current} -> ${info.latest}`));
        });
        if (count > 3) {
          console.log(chalk.gray(`  ... 还有 ${count - 3} 个`));
        }
      } else {
        console.log(chalk.green('✅ 所有依赖都是最新的'));
      }
    } else {
      console.log(chalk.green('✅ 所有依赖都是最新的'));
    }
  } catch (error) {
    console.log(chalk.gray('无法检查过期依赖'));
  }

  console.log(chalk.yellow('\n📝 文档检查'));
  
  // 检查必要文件
  const requiredFiles = ['README.md', 'package.json'];
  requiredFiles.forEach(file => {
    if (existsSync(join(rootDir, file))) {
      console.log(chalk.green(`✅ ${file} 存在`));
    } else {
      console.log(chalk.red(`❌ 缺少文件: ${file}`));
      allChecks = false;
    }
  });

  // 检查发布配置
  if (existsSync(join(rootDir, 'release.config.js'))) {
    console.log(chalk.green('✅ 发布配置文件存在'));
  } else {
    console.log(chalk.yellow('⚠️  未找到发布配置文件'));
  }

  console.log(chalk.yellow('\n🌐 Git 检查'));
  
  // 检查远程仓库
  try {
    const remoteUrl = exec('git config --get remote.origin.url', { allowFailure: true, allowInDryRun: true });
    if (remoteUrl) {
      console.log(chalk.green(`✅ 远程仓库: ${remoteUrl}`));
    } else {
      console.log(chalk.yellow('⚠️  未配置远程仓库'));
    }
  } catch (error) {
    console.log(chalk.yellow('⚠️  无法获取远程仓库信息'));
  }

  console.log(chalk.yellow('\n📦 npm 检查'));
  
  // 检查 npm 登录状态
  try {
    const whoami = exec('npm whoami', { allowFailure: true, allowInDryRun: true });
    if (whoami) {
      console.log(chalk.green(`✅ npm 已登录: ${whoami}`));
    } else {
      console.log(chalk.red('❌ 未登录 npm'));
      allChecks = false;
    }
  } catch (error) {
    console.log(chalk.red('❌ npm 登录检查失败'));
    allChecks = false;
  }

  if (!allChecks) {
    console.log(chalk.red('\n❌ 预发布检查发现问题，请修复后再发布'));
    if (!isDryRun) {
      process.exit(1);
    }
  } else {
    console.log(chalk.green('\n✅ 预发布检查通过'));
  }

  return allChecks;
}

/**
 * 主函数
 */
async function main() {
  let changelogContent = '';
  let newVersion = 'unknown';
  
  try {
    preReleaseCheck();
    checkWorkingDirectory();
    fetchTags();
    checkCodeQuality();

    newVersion = await determineNewVersion();
    changelogContent = generateChangelog(newVersion);

    updatePackageVersion(newVersion);
    buildProject();
    runTests();
    
    if (isDryRun) {
      console.log(chalk.yellow('\n🏃 预演模式完成！'));
      console.log(chalk.gray('要真正发布，请运行: npm run release'));
      return;
    }
    
    commitAndTag(newVersion);
    publishToNpm();
    pushToRemote();
    
    const tagPrefix = config.version?.tagPrefix || 'v';
    console.log(chalk.green(`\n🎉 成功发布版本 ${newVersion}!`));
    console.log(chalk.blue(`📦 npm: https://www.npmjs.com/package/${packageJson.name}`));
    console.log(chalk.blue(`🏷️  标签: ${tagPrefix}${newVersion}`));
    
    await sendNotification('success', { version: newVersion }, changelogContent);
    
  } catch (error) {
    console.log(chalk.red('\n❌ 发布失败:'), error.message);
    await sendNotification('failure', { version: newVersion, error: error.message }, changelogContent);
    process.exit(1);
  }
}

// 运行主函数
main(); 
