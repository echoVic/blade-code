/**
 * SkillInstaller - 内置 Skills 安装器
 *
 * 首次启动时自动下载官方 Skills 到本地目录。
 * 使用 git clone 从 GitHub 下载。
 */

import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createLogger, LogCategory } from '../logging/Logger.js';

const execAsync = promisify(exec);
const logger = createLogger(LogCategory.GENERAL);

/**
 * 官方 Skills 仓库信息
 */
const OFFICIAL_SKILLS_REPO = {
  url: 'https://github.com/anthropics/skills.git',
  branch: 'main',
  // 默认安装的 Skills 列表
  defaultSkills: ['skill-creator'],
};

/**
 * SkillInstaller 类
 */
export class SkillInstaller {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || path.join(homedir(), '.blade', 'skills');
  }

  /**
   * 检查 Skill 是否已安装
   */
  async isInstalled(skillName: string): Promise<boolean> {
    const skillPath = path.join(this.skillsDir, skillName, 'SKILL.md');
    try {
      await fs.access(skillPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查 git 是否可用
   */
  private async isGitAvailable(): Promise<boolean> {
    try {
      await execAsync('git --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 安装官方 Skill（使用 git sparse-checkout）
   */
  async installOfficialSkill(skillName: string): Promise<boolean> {
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

      // 使用 git clone --depth 1 --filter 克隆指定目录
      // 方法：克隆整个仓库（浅克隆），然后只复制需要的目录
      await execAsync(
        `git clone --depth 1 --branch ${branch} --single-branch ${url} "${tempDir}"`,
        { timeout: 30000 }
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
   * 确保默认 Skills 已安装
   * 在首次启动时调用
   */
  async ensureDefaultSkillsInstalled(): Promise<void> {
    // 确保目录存在
    await fs.mkdir(this.skillsDir, { recursive: true, mode: 0o755 });

    for (const skillName of OFFICIAL_SKILLS_REPO.defaultSkills) {
      const installed = await this.isInstalled(skillName);
      if (!installed) {
        await this.installOfficialSkill(skillName);
      }
    }
  }

  /**
   * 安装所有官方 Skills
   */
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
      await execAsync(
        `git clone --depth 1 --branch ${branch} --single-branch ${url} "${tempDir}"`,
        { timeout: 60000 }
      );

      // 获取所有 skills
      const skillsSourceDir = path.join(tempDir, 'skills');
      const entries = await fs.readdir(skillsSourceDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillName = entry.name;
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

/**
 * 获取 SkillInstaller 单例
 */
let installerInstance: SkillInstaller | null = null;

export function getSkillInstaller(skillsDir?: string): SkillInstaller {
  if (!installerInstance) {
    installerInstance = new SkillInstaller(skillsDir);
  }
  return installerInstance;
}


