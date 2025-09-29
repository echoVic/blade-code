/**
 * /init slash command implementation
 * 分析当前项目并生成 BLADE.md 配置文件
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { buildAnalysisPrompt, detectProjectFeatures } from './analysis-prompt.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

async function _analyzeProject(cwd: string): Promise<string> {
  try {
    // 读取 package.json 获取项目信息
    const packageJsonPath = path.join(cwd, 'package.json');
    let projectInfo: any = {};

    try {
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      projectInfo = JSON.parse(packageContent);
    } catch {
      // package.json 不存在或无法解析
    }

    // 检测语言和框架
    const languages = getLanguagesInProject(cwd);
    const frameworks = getFrameworksFromDeps(projectInfo);
    const projectType = detectProjectType(projectInfo, cwd);

    // 生成 BLADE.md 内容
    let content = `# BLADE.md

你是一个专门帮助 ${projectType} 开发者的助手。请特别关注组件化设计和性能优化。

## 项目信息

**项目名称**: ${projectInfo.name || '未知项目'}
**项目类型**: ${projectType}
**主要语言**: ${languages.join(', ') || 'JavaScript/TypeScript'}
`;

    if (frameworks.length > 0) {
      content += `**使用框架**: ${frameworks.join(', ')}\n`;
    }

    if (projectInfo.description) {
      content += `**项目描述**: ${projectInfo.description}\n`;
    }

    content += `
## 开发指导

`;

    // 根据项目类型添加特定指导
    if (frameworks.includes('react')) {
      content += `### React 最佳实践
- 优先使用函数组件和 hooks
- 合理使用 useMemo 和 useCallback 进行性能优化
- 保持组件单一职责原则
- 使用 TypeScript 提供类型安全

`;
    }

    if (frameworks.includes('nextjs')) {
      content += `### Next.js 优化
- 充分利用 SSR/SSG 特性
- 优化图片加载（使用 next/image）
- 合理配置路由和 API routes
- 注意 bundle 大小优化

`;
    }

    if (frameworks.includes('vue')) {
      content += `### Vue.js 最佳实践
- 使用 Composition API
- 合理使用响应式数据
- 组件拆分和复用
- 性能监控和优化

`;
    }

    if (languages.includes('typescript')) {
      content += `### TypeScript 开发
- 严格的类型检查
- 接口定义和类型推导
- 泛型的合理使用
- 避免 any 类型

`;
    }

    // 添加通用开发指导
    content += `### 代码质量
- 保持代码简洁易读
- 编写有意义的注释
- 遵循项目的代码规范
- 重视测试覆盖率

### 问题解决
- 优先查看官方文档
- 注意错误信息和调试
- 考虑性能影响
- 保持依赖更新
`;

    return content;
  } catch (error) {
    throw new Error(
      `项目分析失败: ${error instanceof Error ? error.message : '未知错误'}`
    );
  }
}

function getLanguagesInProject(cwd: string): string[] {
  const languages = new Set<string>();

  try {
    const fs = require('fs');
    const path = require('path');

    const walkDir = (dir: string, depth = 0) => {
      if (depth > 3) return; // 限制递归深度

      try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
          if (file.startsWith('.') || file === 'node_modules') continue;

          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            walkDir(filePath, depth + 1);
          } else {
            const ext = path.extname(file).toLowerCase();
            switch (ext) {
              case '.ts':
              case '.tsx':
                languages.add('typescript');
                break;
              case '.js':
              case '.jsx':
                languages.add('javascript');
                break;
              case '.vue':
                languages.add('vue');
                break;
              case '.py':
                languages.add('python');
                break;
              case '.go':
                languages.add('go');
                break;
              case '.rs':
                languages.add('rust');
                break;
              case '.java':
                languages.add('java');
                break;
            }
          }
        }
      } catch (_error) {
        // 忽略权限错误等
      }
    };

    walkDir(cwd);
  } catch (_error) {
    // 如果出错，回退到基础检测
  }

  return Array.from(languages);
}

function getFrameworksFromDeps(projectInfo: any): string[] {
  const frameworks: string[] = [];
  const deps = { ...projectInfo.dependencies, ...projectInfo.devDependencies };

  if (deps.react) frameworks.push('react');
  if (deps.next) frameworks.push('nextjs');
  if (deps.vue) frameworks.push('vue');
  if (deps.nuxt) frameworks.push('nuxt');
  if (deps.angular) frameworks.push('angular');
  if (deps.express) frameworks.push('express');
  if (deps.koa) frameworks.push('koa');
  if (deps.fastify) frameworks.push('fastify');
  if (deps.electron) frameworks.push('electron');
  if (deps.gatsby) frameworks.push('gatsby');

  return frameworks;
}

function detectProjectType(projectInfo: any, cwd: string): string {
  const deps = { ...projectInfo.dependencies, ...projectInfo.devDependencies };

  if (deps.react) return 'React';
  if (deps.vue) return 'Vue.js';
  if (deps.angular) return 'Angular';
  if (deps.next) return 'Next.js';
  if (deps.nuxt) return 'Nuxt.js';
  if (deps.electron) return 'Electron';
  if (deps.express || deps.koa || deps.fastify) return 'Node.js 后端';

  // 检查文件类型
  const languages = getLanguagesInProject(cwd);
  if (languages.includes('typescript')) return 'TypeScript';
  if (languages.includes('javascript')) return 'JavaScript';
  if (languages.includes('python')) return 'Python';
  if (languages.includes('go')) return 'Go';
  if (languages.includes('rust')) return 'Rust';
  if (languages.includes('java')) return 'Java';

  return 'Node.js';
}

const initCommand: SlashCommand = {
  name: 'init',
  description: '分析当前项目并生成 BLADE.md 配置文件',
  usage: '/init',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    try {
      const { cwd, addAssistantMessage } = context;

      // 检查是否已存在 BLADE.md
      const blademdPath = path.join(cwd, 'BLADE.md');
      const exists = await fs
        .access(blademdPath)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        addAssistantMessage('⚠️ BLADE.md 已存在。');
        addAssistantMessage('💡 建议让 AI 分析现有文件并提供改进建议...');

        // 触发 AI 分析现有文件
        return {
          success: true,
          message: 'trigger_analysis',
          data: {
            analysisPrompt: `Please analyze the existing BLADE.md file in this project and suggest improvements. The file is located at: ${blademdPath}

Please:
1. Read the current BLADE.md content
2. Analyze the project structure and identify any missing information
3. Suggest specific improvements to make the file more useful for future AI assistants
4. Provide an updated version if significant improvements are needed

Focus on practical commands, architecture insights, and development workflows that aren't obvious from just reading individual files.`,
            blademdPath,
            mode: 'improve_existing',
          },
        };
      }

      // 第一阶段：创建空文件并显示进度
      await fs.writeFile(blademdPath, '', 'utf-8');
      addAssistantMessage('✅ 已创建空的 BLADE.md 文件');
      addAssistantMessage('🔍 正在分析项目结构...');

      // 收集项目信息
      const projectInfo = await collectProjectInfo(cwd);

      // 构建详细的分析提示
      const analysisPrompt = buildAnalysisPrompt(projectInfo, cwd);

      // 第二阶段：触发 AI 分析
      return {
        success: true,
        message: 'trigger_analysis',
        data: {
          analysisPrompt,
          blademdPath,
          mode: 'create_new',
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        error: `初始化失败: ${errorMessage}`,
      };
    }
  },
};

/**
 * 收集项目信息用于分析
 */
async function collectProjectInfo(cwd: string) {
  try {
    // 读取 package.json
    const packageJsonPath = path.join(cwd, 'package.json');
    let projectInfo: any = {};
    let hasPackageJson = false;

    try {
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      projectInfo = JSON.parse(packageContent);
      hasPackageJson = true;
    } catch {
      // package.json 不存在或无法解析
    }

    // 检测语言和框架
    const languages = getLanguagesInProject(cwd);
    const frameworks = getFrameworksFromDeps(projectInfo);
    const projectType = detectProjectType(projectInfo, cwd);

    // 检测项目特征
    const features = detectProjectFeatures(
      projectInfo.dependencies || {},
      projectInfo.devDependencies || {},
      projectInfo.scripts || {}
    );

    return {
      name: projectInfo.name || 'unknown-project',
      description: projectInfo.description,
      type: projectType,
      languages,
      frameworks,
      dependencies: projectInfo.dependencies || {},
      devDependencies: projectInfo.devDependencies || {},
      scripts: projectInfo.scripts || {},
      hasPackageJson,
      hasTypeScript: features.hasTypeScript ?? false,
      hasTests: features.hasTests ?? false,
      hasLinting: features.hasLinting ?? false,
      hasFormatting: features.hasFormatting ?? false,
      buildSystem: features.buildSystem,
      testFramework: features.testFramework,
    };
  } catch (error) {
    throw new Error(
      `项目信息收集失败: ${error instanceof Error ? error.message : '未知错误'}`
    );
  }
}

export default initCommand;
