/**
 * 项目分析提示模板
 * 用于生成详细的 AI 分析提示
 */

interface ProjectInfo {
  name: string;
  description?: string;
  type: string;
  languages: string[];
  frameworks: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  hasPackageJson: boolean;
  hasTypeScript: boolean;
  hasTests: boolean;
  hasLinting: boolean;
  hasFormatting: boolean;
  buildSystem?: string;
  testFramework?: string;
}

/**
 * 构建详细的项目分析提示
 */
export function buildAnalysisPrompt(projectInfo: ProjectInfo, cwd: string): string {
  const prompt = `Please analyze this codebase and create a BLADE.md file, which will be given to future instances of Blade Code to operate in this repository.

**Project Information:**
- Name: ${projectInfo.name}
- Type: ${projectInfo.type}
- Languages: ${projectInfo.languages.join(', ') || 'Unknown'}
- Frameworks: ${projectInfo.frameworks.join(', ') || 'None detected'}
- Working Directory: ${cwd}

**Package Information:**
${projectInfo.hasPackageJson ? `
- Has package.json: Yes
- Dependencies: ${Object.keys(projectInfo.dependencies).length} packages
- DevDependencies: ${Object.keys(projectInfo.devDependencies).length} packages
- Scripts: ${Object.keys(projectInfo.scripts).join(', ') || 'None'}
` : '- Has package.json: No'}

**Development Setup:**
- TypeScript: ${projectInfo.hasTypeScript ? 'Yes' : 'No'}
- Testing: ${projectInfo.hasTests ? `Yes (${projectInfo.testFramework || 'Unknown framework'})` : 'No'}
- Linting: ${projectInfo.hasLinting ? 'Yes' : 'No'}
- Formatting: ${projectInfo.hasFormatting ? 'Yes' : 'No'}
${projectInfo.buildSystem ? `- Build System: ${projectInfo.buildSystem}` : ''}

**What to add to BLADE.md:**

1. **Essential Commands**: Commands that will be commonly used, such as:
   - How to build the project
   - How to run tests (including single test execution)
   - How to lint and format code
   - How to start development server
   - Any custom scripts from package.json

2. **High-level Architecture**: Big picture architecture that requires reading multiple files to understand:
   - Project structure and organization
   - Key architectural patterns and design decisions
   - Important relationships between modules/components
   - Entry points and main workflows

3. **Development Guidelines**: Project-specific guidelines that would help developers:
   - Code style and patterns used in this project
   - Testing approach and strategies
   - Build and deployment processes
   - Any unique aspects of this codebase

**Important Notes:**
- Focus on non-obvious information that requires understanding multiple files
- Don't include generic development practices unless they're project-specific
- Include actual commands that work for this project
- Be concise but comprehensive
- Start the file with: "# BLADE.md\\n\\n你是一个专门帮助 ${projectInfo.type} 开发者的助手。"

Please analyze the current codebase structure and generate a comprehensive BLADE.md file with the above information. Write the complete content that should go into the BLADE.md file.`;

  return prompt;
}

/**
 * 检测项目特征
 */
export function detectProjectFeatures(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  scripts: Record<string, string>
): Partial<ProjectInfo> {
  const allDeps = { ...dependencies, ...devDependencies };

  // 检测构建系统
  let buildSystem = 'Unknown';
  if (allDeps.vite) buildSystem = 'Vite';
  else if (allDeps.webpack) buildSystem = 'Webpack';
  else if (allDeps['@angular/cli']) buildSystem = 'Angular CLI';
  else if (allDeps.next) buildSystem = 'Next.js';
  else if (allDeps.nuxt) buildSystem = 'Nuxt.js';
  else if (scripts.build) buildSystem = 'Custom (via npm scripts)';

  // 检测测试框架
  let testFramework = undefined;
  if (allDeps.jest) testFramework = 'Jest';
  else if (allDeps.vitest) testFramework = 'Vitest';
  else if (allDeps.mocha) testFramework = 'Mocha';
  else if (allDeps.jasmine) testFramework = 'Jasmine';
  else if (allDeps['@playwright/test']) testFramework = 'Playwright';
  else if (allDeps.cypress) testFramework = 'Cypress';

  // 检测特征
  const hasTypeScript = Boolean(
    allDeps.typescript ||
    allDeps['@types/node'] ||
    Object.keys(scripts).some(script => scripts[script].includes('tsc'))
  );

  const hasTests = Boolean(
    testFramework ||
    Object.keys(scripts).some(script => script.includes('test')) ||
    allDeps['@testing-library/react'] ||
    allDeps['@testing-library/vue']
  );

  const hasLinting = Boolean(
    allDeps.eslint ||
    allDeps.biome ||
    allDeps.tslint ||
    Object.keys(scripts).some(script => script.includes('lint'))
  );

  const hasFormatting = Boolean(
    allDeps.prettier ||
    allDeps.biome ||
    Object.keys(scripts).some(script => script.includes('format'))
  );

  return {
    hasTypeScript,
    hasTests,
    hasLinting,
    hasFormatting,
    buildSystem: buildSystem !== 'Unknown' ? buildSystem : undefined,
    testFramework
  };
}