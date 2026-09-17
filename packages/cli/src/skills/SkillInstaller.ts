// Explicit installation of official, repository, or local skills.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createLogger, LogCategory } from '../logging/Logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger(LogCategory.GENERAL);

export function isValidSkillInstallName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  );
}

export function isSafeSkillRepositoryUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /\s/.test(value)) return false;
  if (
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return false;
  if (value.startsWith('git@')) {
    return /^git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(
      value
    );
  }
  if (!/^(https|ssh):\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'ssh:') &&
      Boolean(url.hostname) &&
      !url.hostname.startsWith('-') &&
      !url.password &&
      !(url.protocol === 'https:' && url.username) &&
      !(url.username && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.username)) &&
      !url.search &&
      !url.hash &&
      url.pathname !== '/'
    );
  } catch {
    return false;
  }
}

export function skillNameFromRepositoryUrl(url: string): string {
  const pathname = url.startsWith('git@')
    ? url.slice(url.indexOf(':') + 1)
    : new URL(url).pathname;
  return path.posix.basename(pathname.replace(/\/+$/, '')).replace(/\.git$/, '');
}

/** 官方 Skills 仓库信息 */
const OFFICIAL_SKILLS_REPO = {
  url: 'https://github.com/anthropics/skills.git',
  branch: 'main',
};

/** SkillInstaller 类 */
export class SkillInstaller {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || path.join(homedir(), '.blade', 'skills');
  }

  /** 检查 git 是否可用 */
  private async isGitAvailable(): Promise<boolean> {
    try {
      await this.runGit(['--version'], 5000);
      return true;
    } catch {
      return false;
    }
  }

  private async runGit(args: string[], timeout: number): Promise<void> {
    await execFileAsync('git', args, {
      shell: false,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  async installOfficialSkill(skillName: string): Promise<boolean> {
    if (!isValidSkillInstallName(skillName)) return false;
    const { url, branch } = OFFICIAL_SKILLS_REPO;
    const localPath = path.join(this.skillsDir, skillName);
    const tempDir = path.join(this.skillsDir, `.tmp-${skillName}-${Date.now()}`);

    try {
      // 检查 git
      if (!(await this.isGitAvailable())) {
        logger.warn('Git not available, skipping skill installation');
        return false;
      }

      logger.info(`Installing official skill: ${skillName}...`);

      // 确保目录存在
      await fs.mkdir(this.skillsDir, { recursive: true, mode: 0o755 });

      // 使用 git clone --depth 1 --filter 克隆指定目录 方法：克隆整个仓库（浅克隆），然后只复制需要的目录
      await this.runGit(
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          branch,
          '--single-branch',
          '--',
          url,
          tempDir,
        ],
        30000
      );

      // 复制指定的 skill 目录
      const sourceDir = path.join(tempDir, 'skills', skillName);

      try {
        await fs.access(sourceDir);
      } catch {
        logger.warn(`Skill ${skillName} not found in official repository`);
        await fs.rm(tempDir, { recursive: true, force: true });
        return false;
      }

      // 如果目标已存在，先删除
      try {
        await fs.rm(localPath, { recursive: true, force: true });
      } catch {
        // 忽略
      }

      // 复制到目标位置
      await fs.cp(sourceDir, localPath, { recursive: true });

      // 清理临时目录
      await fs.rm(tempDir, { recursive: true, force: true });

      logger.info(`Successfully installed: ${skillName}`);
      return true;
    } catch (error) {
      // 清理临时目录
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }

      logger.warn(
        `Failed to install ${skillName}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    }
  }

  /**
   * 从 GitHub 仓库安装 Skill
   * @param repoUrl GitHub 仓库 URL (例如: https://github.com/user/skill-name)
   * @param skillName 可选的 skill 名称，默认从 URL 提取
   */
  async installFromRepo(repoUrl: string, skillName?: string): Promise<boolean> {
    if (!isSafeSkillRepositoryUrl(repoUrl)) return false;
    const name = skillName ?? skillNameFromRepositoryUrl(repoUrl);
    if (!isValidSkillInstallName(name)) return false;
    const localPath = path.join(this.skillsDir, name);
    const tempDir = path.join(this.skillsDir, `.tmp-repo-${name}-${Date.now()}`);

    try {
      if (!(await this.isGitAvailable())) {
        logger.warn('Git not available, cannot install from repo');
        return false;
      }

      logger.info(`Installing skill from repo: ${repoUrl}...`);

      await fs.mkdir(this.skillsDir, { recursive: true, mode: 0o755 });

      await this.runGit(['clone', '--depth', '1', '--', repoUrl, tempDir], 60000);

      const skillMdPath = path.join(tempDir, 'SKILL.md');
      try {
        await fs.access(skillMdPath);
      } catch {
        logger.warn(`No SKILL.md found in repository ${repoUrl}`);
        await fs.rm(tempDir, { recursive: true, force: true });
        return false;
      }

      await fs.rm(localPath, { recursive: true, force: true });
      await fs.rename(tempDir, localPath);

      try {
        await fs.rm(path.join(localPath, '.git'), { recursive: true, force: true });
      } catch {
        // ignore
      }

      logger.info(`Successfully installed skill from repo: ${name}`);
      return true;
    } catch (error) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      logger.warn(
        `Failed to install from repo ${repoUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    }
  }

  /**
   * 从本地路径安装 Skill（创建符号链接或复制）
   * @param localSourcePath 本地 skill 路径
   * @param skillName 可选的 skill 名称，默认从路径提取
   * @param symlink 是否使用符号链接（默认 true，方便开发）
   */
  async installFromLocal(
    localSourcePath: string,
    skillName?: string,
    symlink = true
  ): Promise<boolean> {
    if (
      typeof localSourcePath !== 'string' ||
      !localSourcePath.trim() ||
      localSourcePath.includes('\0')
    )
      return false;
    const name = skillName ?? path.basename(localSourcePath);
    if (!isValidSkillInstallName(name)) return false;
    const targetPath = path.resolve(this.skillsDir, name);

    try {
      const sourcePath = await fs.realpath(path.resolve(localSourcePath));
      let targetParent = path.dirname(targetPath);
      const missingParts: string[] = [];
      while (true) {
        try {
          targetParent = path.join(await fs.realpath(targetParent), ...missingParts);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missingParts.unshift(path.basename(targetParent));
          targetParent = path.dirname(targetParent);
        }
      }
      let resolvedTarget = path.join(targetParent, name);
      try {
        if (!(await fs.lstat(resolvedTarget)).isSymbolicLink()) {
          resolvedTarget = await fs.realpath(resolvedTarget);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        [
          path.relative(resolvedTarget, sourcePath),
          path.relative(sourcePath, resolvedTarget),
        ].some(
          (relative) =>
            relative === '' ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== '..' &&
              !path.isAbsolute(relative))
        )
      )
        return false;

      const skillMdPath = path.join(sourcePath, 'SKILL.md');
      try {
        await fs.access(skillMdPath);
      } catch {
        logger.warn(`No SKILL.md found in local path: ${sourcePath}`);
        return false;
      }

      logger.info(`Installing skill from local path: ${sourcePath}...`);

      await fs.mkdir(this.skillsDir, { recursive: true, mode: 0o755 });

      await fs.rm(targetPath, { recursive: true, force: true });

      if (symlink) {
        await fs.symlink(sourcePath, targetPath, 'dir');
        logger.info(`Created symlink for skill: ${name}`);
      } else {
        await fs.cp(sourcePath, targetPath, { recursive: true });
        logger.info(`Copied skill to: ${name}`);
      }

      return true;
    } catch (error) {
      logger.warn(
        `Failed to install from local path ${localSourcePath}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    }
  }

  /** 安装所有官方 Skills */
  async installAllOfficialSkills(): Promise<{ installed: string[]; failed: string[] }> {
    const { url, branch } = OFFICIAL_SKILLS_REPO;
    const tempDir = path.join(this.skillsDir, `.tmp-all-${Date.now()}`);
    const installed: string[] = [];
    const failed: string[] = [];

    try {
      // 检查 git
      if (!(await this.isGitAvailable())) {
        logger.warn('Git not available, skipping skill installation');
        return { installed, failed };
      }

      // 确保目录存在
      await fs.mkdir(this.skillsDir, { recursive: true, mode: 0o755 });

      // 克隆整个仓库
      logger.info('Cloning official skills repository...');
      await this.runGit(
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          branch,
          '--single-branch',
          '--',
          url,
          tempDir,
        ],
        60000
      );

      // 获取所有 skills
      const skillsSourceDir = path.join(tempDir, 'skills');
      const entries = await fs.readdir(skillsSourceDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillName = entry.name;
        if (!isValidSkillInstallName(skillName)) {
          failed.push(skillName);
          continue;
        }
        const sourceDir = path.join(skillsSourceDir, skillName);
        const localPath = path.join(this.skillsDir, skillName);

        try {
          // 检查是否有 SKILL.md
          await fs.access(path.join(sourceDir, 'SKILL.md'));

          // 复制到目标位置
          await fs.rm(localPath, { recursive: true, force: true });
          await fs.cp(sourceDir, localPath, { recursive: true });

          logger.info(`Installed: ${skillName}`);
          installed.push(skillName);
        } catch (_error) {
          logger.warn(`Failed to install ${skillName}`);
          failed.push(skillName);
        }
      }

      // 清理临时目录
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // 清理临时目录
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
      logger.warn(
        `Failed to install skills: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    return { installed, failed };
  }
}

/** 获取 SkillInstaller 单例 */
let installerInstance: SkillInstaller | null = null;

export function getSkillInstaller(skillsDir?: string): SkillInstaller {
  if (!installerInstance) {
    installerInstance = new SkillInstaller(skillsDir);
  }
  return installerInstance;
}
