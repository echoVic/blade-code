import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import type { BladeConfig } from '../config/types/index.js';

const execAsync = promisify(exec);

export class GitService {
  private config: BladeConfig;
  private gitPath: string;

  constructor(config: BladeConfig) {
    this.config = config;
    this.gitPath = this.detectGitPath();
  }

  private detectGitPath(): string {
    // 检查环境变量
    if (process.env.GIT_PATH) {
      return process.env.GIT_PATH;
    }

    // 返回默认git命令
    return 'git';
  }

  public async initialize(): Promise<void> {
    console.log('Git服务初始化完成');
  }

  // 仓库操作
  public async init(repoPath: string, options?: GitInitOptions): Promise<GitResult> {
    try {
      const args = ['init'];

      if (options?.bare) {
        args.push('--bare');
      }

      if (options?.template) {
        args.push('--template', options.template);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`Git仓库初始化成功: ${repoPath}`);
      return result;
    } catch (error) {
      console.error(`Git仓库初始化失败: ${repoPath}`, error);
      throw error;
    }
  }

  public async clone(
    url: string,
    targetPath: string,
    options?: GitCloneOptions
  ): Promise<GitResult> {
    try {
      const args = ['clone'];

      if (options?.depth) {
        args.push('--depth', options.depth.toString());
      }

      if (options?.branch) {
        args.push('--branch', options.branch);
      }

      if (options?.singleBranch) {
        args.push('--single-branch');
      }

      if (options?.noCheckout) {
        args.push('--no-checkout');
      }

      args.push(url, targetPath);

      const result = await this.executeGitCommand(args);
      console.log(`Git仓库克隆成功: ${url} -> ${targetPath}`);
      return result;
    } catch (error) {
      console.error(`Git仓库克隆失败: ${url}`, error);
      throw error;
    }
  }

  // 状态检查
  public async status(
    repoPath: string,
    options?: GitStatusOptions
  ): Promise<GitStatus> {
    try {
      const args = ['status', '--porcelain'];

      if (options?.includeUntracked) {
        args.push('-u');
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      const status = this.parseStatusOutput(result.stdout);

      return {
        ...status,
        rawOutput: result.stdout,
        isClean: status.changedFiles.length === 0 && status.untrackedFiles.length === 0,
      };
    } catch (error) {
      console.error(`Git状态检查失败: ${repoPath}`, error);
      throw error;
    }
  }

  private parseStatusOutput(output: string): Omit<GitStatus, 'rawOutput' | 'isClean'> {
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '');

    const changedFiles: GitChangedFile[] = [];
    const untrackedFiles: string[] = [];

    for (const line of lines) {
      if (line.startsWith('??')) {
        // 未跟踪文件
        untrackedFiles.push(line.substring(3).trim());
      } else {
        // 已修改文件
        const status = line.substring(0, 2);
        const filePath = line.substring(3).trim();

        const statusType: GitStatusType = this.parseStatusType(status);
        changedFiles.push({
          path: filePath,
          status: statusType,
          staged: status[0] !== ' ' && status[0] !== '?',
        });
      }
    }

    return {
      changedFiles,
      untrackedFiles,
    };
  }

  private parseStatusType(status: string): GitStatusType {
    const [indexStatus, workingStatus] = status.split('');

    if (indexStatus === 'A' || workingStatus === 'A') return 'added';
    if (indexStatus === 'M' || workingStatus === 'M') return 'modified';
    if (indexStatus === 'D' || workingStatus === 'D') return 'deleted';
    if (indexStatus === 'R' || workingStatus === 'R') return 'renamed';
    if (indexStatus === 'C' || workingStatus === 'C') return 'copied';
    if (workingStatus === 'U') return 'unmerged';

    return 'unknown';
  }

  // 添加文件
  public async add(
    repoPath: string,
    files: string | string[],
    options?: GitAddOptions
  ): Promise<GitResult> {
    try {
      const args = ['add'];

      if (options?.force) {
        args.push('--force');
      }

      if (options?.update) {
        args.push('--update');
      }

      const filesArray = Array.isArray(files) ? files : [files];
      args.push(...filesArray);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`文件添加成功: ${filesArray.join(', ')}`);
      return result;
    } catch (error) {
      console.error(`文件添加失败`, error);
      throw error;
    }
  }

  // 提交
  public async commit(
    repoPath: string,
    message: string,
    options?: GitCommitOptions
  ): Promise<GitResult> {
    try {
      const args = ['commit'];

      if (options?.all) {
        args.push('--all');
      }

      if (options?.amend) {
        args.push('--amend');
      }

      if (options?.noVerify) {
        args.push('--no-verify');
      }

      args.push('-m', message);

      const result = await this.executeGitCommand(args, { cwd: repoPath });

      // 解析提交信息
      const commitInfo = this.parseCommitOutput(result.stdout);

      console.log(`提交成功: ${commitInfo.hash}`);
      return {
        ...result,
        commitInfo,
      };
    } catch (error) {
      console.error(`提交失败`, error);
      throw error;
    }
  }

  private parseCommitOutput(output: string): GitCommitInfo {
    const lines = output.trim().split('\n');
    const commitLine = lines.find((line) => line.startsWith('[')) || '';

    const match = commitLine.match(/\[([^\s]+) ([a-f0-9]+)\]/);
    if (match) {
      return {
        branch: match[1],
        hash: match[2],
      };
    }

    return {
      branch: 'unknown',
      hash: 'unknown',
    };
  }

  // 推送
  public async push(repoPath: string, options?: GitPushOptions): Promise<GitResult> {
    try {
      const args = ['push'];

      if (options?.force) {
        args.push('--force');
      }

      if (options?.forceWithLease) {
        args.push('--force-with-lease');
      }

      if (options?.setUpstream && options.remote && options.branch) {
        args.push('--set-upstream');
      }

      if (options?.remote) {
        args.push(options.remote);
      }

      if (options?.branch) {
        args.push(options.branch);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log('推送成功');
      return result;
    } catch (error) {
      console.error('推送失败', error);
      throw error;
    }
  }

  // 拉取
  public async pull(repoPath: string, options?: GitPullOptions): Promise<GitResult> {
    try {
      const args = ['pull'];

      if (options?.rebase) {
        args.push('--rebase');
      }

      if (options?.ffOnly) {
        args.push('--ff-only');
      }

      if (options?.remote) {
        args.push(options.remote);
      }

      if (options?.branch) {
        args.push(options.branch);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log('拉取成功');
      return result;
    } catch (error) {
      console.error('拉取失败', error);
      throw error;
    }
  }

  // 分支操作
  public async createBranch(
    repoPath: string,
    branchName: string,
    options?: GitBranchOptions
  ): Promise<GitResult> {
    try {
      const args = ['branch'];

      if (options?.force) {
        args.push('--force');
      }

      args.push(branchName);

      if (options?.startPoint) {
        args.push(options.startPoint);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`分支创建成功: ${branchName}`);
      return result;
    } catch (error) {
      console.error(`分支创建失败: ${branchName}`, error);
      throw error;
    }
  }

  public async checkout(
    repoPath: string,
    target: string,
    options?: GitCheckoutOptions
  ): Promise<GitResult> {
    try {
      const args = ['checkout'];

      if (options?.create) {
        args.push('-b');
      }

      if (options?.force) {
        args.push('--force');
      }

      args.push(target);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`检出成功: ${target}`);
      return result;
    } catch (error) {
      console.error(`检出失败: ${target}`, error);
      throw error;
    }
  }

  public async deleteBranch(
    repoPath: string,
    branchName: string,
    options?: GitBranchDeleteOptions
  ): Promise<GitResult> {
    try {
      const args = ['branch', '-d'];

      if (options?.force) {
        args[1] = '-D';
      }

      args.push(branchName);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`分支删除成功: ${branchName}`);
      return result;
    } catch (error) {
      console.error(`分支删除失败: ${branchName}`, error);
      throw error;
    }
  }

  public async listBranches(
    repoPath: string,
    options?: GitBranchListOptions
  ): Promise<GitBranchInfo[]> {
    try {
      const args = ['branch'];

      if (options?.all) {
        args.push('-a');
      }

      if (options?.remote) {
        args.push('-r');
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      return this.parseBranchListOutput(result.stdout);
    } catch (error) {
      console.error('获取分支列表失败', error);
      throw error;
    }
  }

  private parseBranchListOutput(output: string): GitBranchInfo[] {
    const lines = output.trim().split('\n');
    const branches: GitBranchInfo[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const isCurrent = line.startsWith('*');
      const branchName = line.substring(2).trim();
      const isRemote = branchName.includes('origin/') || branchName.includes('remote/');

      branches.push({
        name: branchName,
        isCurrent,
        isRemote,
      });
    }

    return branches;
  }

  // 日志
  public async log(repoPath: string, options?: GitLogOptions): Promise<GitCommit[]> {
    try {
      const args = ['log', '--pretty=format:%H|%an|%ae|%ad|%s'];

      if (options?.maxCount) {
        args.push(`-n ${options.maxCount}`);
      }

      if (options?.since) {
        args.push(`--since="${options.since}"`);
      }

      if (options?.until) {
        args.push(`--until="${options.until}"`);
      }

      if (options?.author) {
        args.push(`--author="${options.author}"`);
      }

      if (options?.path) {
        args.push('--', options.path);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      return this.parseLogOutput(result.stdout);
    } catch (error) {
      console.error('获取日志失败', error);
      throw error;
    }
  }

  private parseLogOutput(output: string): GitCommit[] {
    const lines = output.trim().split('\n');
    const commits: GitCommit[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const [hash, authorName, authorEmail, date, message] = line.split('|');

      commits.push({
        hash,
        author: {
          name: authorName,
          email: authorEmail,
        },
        date: new Date(date),
        message,
      });
    }

    return commits;
  }

  // 差异
  public async diff(
    repoPath: string,
    options?: GitDiffOptions
  ): Promise<GitDiffResult> {
    try {
      const args = ['diff'];

      if (options?.cached) {
        args.push('--cached');
      }

      if (options?.nameOnly) {
        args.push('--name-only');
      }

      if (options?.stat) {
        args.push('--stat');
      }

      if (options?.from && options?.to) {
        args.push(options.from, options.to);
      } else if (options?.from) {
        args.push(options.from);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });

      return {
        files: options?.nameOnly
          ? result.stdout
              .trim()
              .split('\n')
              .filter((line) => line.trim())
          : [],
        diff: options?.nameOnly ? '' : result.stdout,
        stat: result.stderr,
      };
    } catch (error) {
      console.error('获取差异失败', error);
      throw error;
    }
  }

  // 配置
  public async getConfig(
    repoPath: string,
    key: string,
    options?: GitConfigOptions
  ): Promise<string> {
    try {
      const args = ['config'];

      if (options?.global) {
        args.push('--global');
      }

      args.push(key);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      return result.stdout.trim();
    } catch (error) {
      console.error(`获取配置失败: ${key}`, error);
      throw error;
    }
  }

  public async setConfig(
    repoPath: string,
    key: string,
    value: string,
    options?: GitConfigOptions
  ): Promise<GitResult> {
    try {
      const args = ['config'];

      if (options?.global) {
        args.push('--global');
      }

      if (options?.add) {
        args.push('--add');
      }

      args.push(key, value);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`配置设置成功: ${key} = ${value}`);
      return result;
    } catch (error) {
      console.error(`配置设置失败: ${key}`, error);
      throw error;
    }
  }

  // 标签
  public async createTag(
    repoPath: string,
    tagName: string,
    options?: GitTagOptions
  ): Promise<GitResult> {
    try {
      const args = ['tag'];

      if (options?.annotate) {
        args.push('-a');
      }

      if (options?.message) {
        args.push('-m', options.message);
      }

      args.push(tagName);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`标签创建成功: ${tagName}`);
      return result;
    } catch (error) {
      console.error(`标签创建失败: ${tagName}`, error);
      throw error;
    }
  }

  public async listTags(repoPath: string): Promise<string[]> {
    try {
      const result = await this.executeGitCommand(['tag'], { cwd: repoPath });
      return result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());
    } catch (error) {
      console.error('获取标签列表失败', error);
      throw error;
    }
  }

  // 重置
  public async reset(repoPath: string, options?: GitResetOptions): Promise<GitResult> {
    try {
      const args = ['reset'];

      if (options?.soft) {
        args.push('--soft');
      } else if (options?.hard) {
        args.push('--hard');
      } else if (options?.mixed) {
        args.push('--mixed');
      }

      if (options?.commit) {
        args.push(options.commit);
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log('重置成功');
      return result;
    } catch (error) {
      console.error('重置失败', error);
      throw error;
    }
  }

  // 合并
  public async merge(
    repoPath: string,
    branch: string,
    options?: GitMergeOptions
  ): Promise<GitResult> {
    try {
      const args = ['merge'];

      if (options?.noCommit) {
        args.push('--no-commit');
      }

      if (options?.noFastForward) {
        args.push('--no-ff');
      }

      if (options?.squash) {
        args.push('--squash');
      }

      args.push(branch);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`合并成功: ${branch}`);
      return result;
    } catch (error) {
      console.error(`合并失败: ${branch}`, error);
      throw error;
    }
  }

  // 变基
  public async rebase(
    repoPath: string,
    branch: string,
    options?: GitRebaseOptions
  ): Promise<GitResult> {
    try {
      const args = ['rebase'];

      if (options?.interactive) {
        args.push('-i');
      }

      if (options?.onto) {
        args.push('--onto', options.onto);
      }

      args.push(branch);

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log(`变基成功: ${branch}`);
      return result;
    } catch (error) {
      console.error(`变基失败: ${branch}`, error);
      throw error;
    }
  }

  // stash
  public async stash(repoPath: string, options?: GitStashOptions): Promise<GitResult> {
    try {
      const args = ['stash'];

      if (options?.push) {
        args.push('push');

        if (options?.message) {
          args.push('-m', options.message);
        }

        if (options?.includeUntracked) {
          args.push('-u');
        }

        if (options?.all) {
          args.push('-a');
        }
      } else if (options?.pop) {
        args.push('pop');
      } else if (options?.apply) {
        args.push('apply');
      } else if (options?.list) {
        args.push('list');
      } else if (options?.drop) {
        args.push('drop');
      } else if (options?.clear) {
        args.push('clear');
      }

      const result = await this.executeGitCommand(args, { cwd: repoPath });
      console.log('Stash操作成功');
      return result;
    } catch (error) {
      console.error('Stash操作失败', error);
      throw error;
    }
  }

  // 远程仓库
  public async addRemote(
    repoPath: string,
    name: string,
    url: string
  ): Promise<GitResult> {
    try {
      const result = await this.executeGitCommand(['remote', 'add', name, url], {
        cwd: repoPath,
      });
      console.log(`远程仓库添加成功: ${name} -> ${url}`);
      return result;
    } catch (error) {
      console.error(`远程仓库添加失败: ${name}`, error);
      throw error;
    }
  }

  public async removeRemote(repoPath: string, name: string): Promise<GitResult> {
    try {
      const result = await this.executeGitCommand(['remote', 'remove', name], {
        cwd: repoPath,
      });
      console.log(`远程仓库移除成功: ${name}`);
      return result;
    } catch (error) {
      console.error(`远程仓库移除失败: ${name}`, error);
      throw error;
    }
  }

  public async listRemotes(repoPath: string): Promise<GitRemote[]> {
    try {
      const result = await this.executeGitCommand(['remote', '-v'], { cwd: repoPath });
      return this.parseRemoteListOutput(result.stdout);
    } catch (error) {
      console.error('获取远程仓库列表失败', error);
      throw error;
    }
  }

  private parseRemoteListOutput(output: string): GitRemote[] {
    const lines = output.trim().split('\n');
    const remotes: GitRemote[] = [];
    const remoteMap: Record<string, GitRemote> = {};

    for (const line of lines) {
      if (!line.trim()) continue;

      const [name, urlAndType] = line.split('\t');
      const [url, type] = urlAndType.split(' ');

      if (!remoteMap[name]) {
        remoteMap[name] = { name, urls: {} };
        remotes.push(remoteMap[name]);
      }

      remoteMap[name].urls[type.replace('(', '').replace(')', '')] = url;
    }

    return remotes;
  }

  // 实用工具方法
  public async isRepository(repoPath: string): Promise<boolean> {
    try {
      await this.executeGitCommand(['rev-parse', '--git-dir'], { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  public async getCurrentBranch(repoPath: string): Promise<string> {
    try {
      const result = await this.executeGitCommand(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: repoPath }
      );
      return result.stdout.trim();
    } catch (error) {
      console.error('获取当前分支失败', error);
      throw error;
    }
  }

  public async getLastCommit(repoPath: string): Promise<GitCommit> {
    try {
      const result = await this.executeGitCommand(
        ['log', '-1', '--pretty=format:%H|%an|%ae|%ad|%s'],
        { cwd: repoPath }
      );
      const [hash, authorName, authorEmail, date, message] = result.stdout
        .trim()
        .split('|');

      return {
        hash,
        author: {
          name: authorName,
          email: authorEmail,
        },
        date: new Date(date),
        message,
      };
    } catch (error) {
      console.error('获取最后提交失败', error);
      throw error;
    }
  }

  // 执行Git命令的通用方法
  private async executeGitCommand(
    args: string[],
    options?: GitCommandOptions
  ): Promise<GitResult> {
    const cwd = options?.cwd || process.cwd();
    const timeout = options?.timeout || 30000;

    return new Promise((resolve, reject) => {
      const command = `${this.gitPath} ${args.join(' ')}`;

      const child = spawn(this.gitPath, args, {
        cwd,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill();
        reject(new Error(`Git命令超时: ${command}`));
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);

        const result: GitResult = {
          command,
          args,
          stdout,
          stderr,
          code: code || 0,
        };

        if (code === 0) {
          resolve(result);
        } else {
          reject(new Error(`Git命令失败: ${command}\n${stderr}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Git命令执行错误: ${command}\n${error.message}`));
      });
    });
  }

  public async destroy(): Promise<void> {
    console.log('Git服务已销毁');
  }
}

// 类型定义
interface GitCommandOptions {
  cwd?: string;
  timeout?: number;
}

export interface GitResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number;
  commitInfo?: GitCommitInfo;
}

interface GitCommitInfo {
  branch: string;
  hash: string;
}

interface GitInitOptions {
  bare?: boolean;
  template?: string;
}

interface GitCloneOptions {
  depth?: number;
  branch?: string;
  singleBranch?: boolean;
  noCheckout?: boolean;
}

interface GitStatusOptions {
  includeUntracked?: boolean;
}

export interface GitStatus {
  changedFiles: GitChangedFile[];
  untrackedFiles: string[];
  rawOutput: string;
  isClean: boolean;
}

interface GitChangedFile {
  path: string;
  status: GitStatusType;
  staged: boolean;
}

type GitStatusType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'unknown';

interface GitAddOptions {
  force?: boolean;
  update?: boolean;
}

interface GitCommitOptions {
  all?: boolean;
  amend?: boolean;
  noVerify?: boolean;
}

interface GitPushOptions {
  remote?: string;
  branch?: string;
  force?: boolean;
  forceWithLease?: boolean;
  setUpstream?: boolean;
}

interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
  ffOnly?: boolean;
}

interface GitBranchOptions {
  force?: boolean;
  startPoint?: string;
}

interface GitCheckoutOptions {
  create?: boolean;
  force?: boolean;
}

interface GitBranchDeleteOptions {
  force?: boolean;
}

interface GitBranchListOptions {
  all?: boolean;
  remote?: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

interface GitLogOptions {
  maxCount?: number;
  since?: string;
  until?: string;
  author?: string;
  path?: string;
}

export interface GitCommit {
  hash: string;
  author: {
    name: string;
    email: string;
  };
  date: Date;
  message: string;
}

interface GitDiffOptions {
  cached?: boolean;
  nameOnly?: boolean;
  stat?: boolean;
  from?: string;
  to?: string;
}

interface GitDiffResult {
  files: string[];
  diff: string;
  stat: string;
}

interface GitConfigOptions {
  global?: boolean;
  add?: boolean;
}

interface GitTagOptions {
  annotate?: boolean;
  message?: string;
}

interface GitResetOptions {
  soft?: boolean;
  hard?: boolean;
  mixed?: boolean;
  commit?: string;
}

interface GitMergeOptions {
  noCommit?: boolean;
  noFastForward?: boolean;
  squash?: boolean;
}

interface GitRebaseOptions {
  interactive?: boolean;
  onto?: string;
}

interface GitStashOptions {
  push?: boolean;
  pop?: boolean;
  apply?: boolean;
  list?: boolean;
  drop?: boolean;
  clear?: boolean;
  message?: string;
  includeUntracked?: boolean;
  all?: boolean;
}

interface GitRemote {
  name: string;
  urls: Record<string, string>;
}
