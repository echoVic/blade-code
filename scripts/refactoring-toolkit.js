#!/usr/bin/env node

/**
 * Blade Monorepo 重构工具包
 * 
 * 这个工具包提供了重构项目所需的自动化工具和检查清单
 * 使用方法: node scripts/refactoring-toolkit.js [command] [options]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 重构配置
const REFACTORING_CONFIG = {
  phases: [
    {
      id: 'architecture',
      name: '架构重构',
      duration: 4,
      goals: ['拆分Agent类', '实现管理器分离', '统一配置系统', '建立质量标准'],
      keyDeliverables: ['重构后的核心架构', '配置管理系统', '代码质量工具链']
    },
    {
      id: 'security',
      name: '安全加固',
      duration: 3,
      goals: ['修复高风险漏洞', '网络安全加固', '数据保护', '合规性检查'],
      keyDeliverables: ['安全加固的系统', '安全测试套件', '合规文档']
    },
    {
      id: 'performance',
      name: '性能优化',
      duration: 4,
      goals: ['React-Ink UI优化', 'LLM请求优化', '构建优化', '监控体系'],
      keyDeliverables: ['高性能系统', '性能监控面板', '优化工具链']
    },
    {
      id: 'testing',
      name: '测试体系',
      duration: 3,
      goals: ['测试框架搭建', '单元测试', '集成测试', '端到端测试'],
      keyDeliverables: ['完整测试覆盖', '自动化测试', '测试报告系统']
    },
    {
      id: 'documentation',
      name: '文档运维',
      duration: 2,
      goals: ['技术文档', '用户文档', '监控系统', '运维自动化'],
      keyDeliverables: ['完整文档体系', '监控系统', '自动化运维']
    }
  ],
  team: {
    architect: 1,
    frontend: 1,
    backend: 2,
    security: 1,
    qa: 1,
    devops: 1,
    techwriter: 1
  },
  estimatedBudget: 630000, // USD
  estimatedDuration: 16 // weeks
};

// 命令行工具
class RefactoringToolkit {
  constructor() {
    this.commands = {
      'init': this.initializeProject.bind(this),
      'check': this.runHealthCheck.bind(this),
      'plan': this.generatePhasePlan.bind(this),
      'metrics': this.showMetrics.bind(this),
      'setup': this.setupEnvironment.bind(this),
      'audit': this.runSecurityAudit.bind(this),
      'report': this.generateReport.bind(this),
      'help': this.showHelp.bind(this)
    };
  }

  async run(args) {
    const command = args[2] || 'help';
    const options = args.slice(3);

    if (this.commands[command]) {
      await this.commands[command](options);
    } else {
      console.error(`未知命令: ${command}`);
      this.showHelp();
    }
  }

  async initializeProject(options) {
    console.log('🚀 正在初始化 Blade 重构项目...');
    
    // 创建项目结构
    const directories = [
      'scripts/refactoring',
      'docs/refactoring',
      'tests/refactoring',
      'config/refactoring',
      'monitoring/reports',
      'backup'
    ];

    for (const dir of directories) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ 创建目录: ${dir}`);
      }
    }

    // 创建配置文件
    const config = {
      projectName: 'blade-refactoring',
      version: '1.0.0',
      startDate: new Date().toISOString(),
      estimatedCompletion: new Date(Date.now() + 16 * 7 * 24 * 60 * 60 * 1000).toISOString(),
      phases: REFACTORING_CONFIG.phases,
      team: REFACTORING_CONFIG.team,
      budget: REFACTORING_CONFIG.estimatedBudget,
      status: 'initialized'
    };

    fs.writeFileSync(
      'config/refactoring/project.json',
      JSON.stringify(config, null, 2)
    );
    console.log('✅ 创建项目配置文件');

    // 创建初始里程碑
    const milestones = this.generateMilestones();
    fs.writeFileSync(
      'config/refactoring/milestones.json',
      JSON.stringify(milestones, null, 2)
    );
    console.log('✅ 创建里程碑文件');

    console.log('🎉 项目初始化完成！');
    console.log('📋 下一步: 运行 node scripts/refactoring-toolkit.js plan 查看详细计划');
  }

  async runHealthCheck(options) {
    console.log('🔍 正在进行项目健康检查...');

    const checks = [
      {
        name: '项目结构',
        check: () => {
          const requiredDirs = ['src', 'packages', 'docs', 'tests'];
          return requiredDirs.every(dir => fs.existsSync(dir));
        }
      },
      {
        name: '版本控制',
        check: () => fs.existsSync('.git')
      },
      {
        name: '包管理',
        check: () => fs.existsSync('package.json') && fs.existsSync('pnpm-lock.yaml')
      },
      {
        name: 'TypeScript配置',
        check: () => fs.existsSync('tsconfig.json')
      },
      {
        name: '构建配置',
        check: () => fs.existsSync('tsup.config.ts')
      },
      {
        name: '文档系统',
        check: () => fs.existsSync('docs') && fs.readdirSync('docs').length > 0
      }
    ];

    const results = [];
    for (const check of checks) {
      const passed = check.check();
      results.push({
        name: check.name,
        status: passed ? '✅ 通过' : '❌ 失败',
        passed
      });
    }

    console.log('\n📊 健康检查结果:');
    results.forEach(result => {
      console.log(`  ${result.status} ${result.name}`);
    });

    const passedCount = results.filter(r => r.passed).length;
    const totalChecks = results.length;
    console.log(`\n📈 总体评分: ${passedCount}/${totalChecks} (${Math.round(passedCount/totalChecks*100)}%)`);

    if (passedCount === totalChecks) {
      console.log('🎉 项目结构健康，可以开始重构！');
    } else {
      console.log('⚠️  项目存在一些问题，建议先修复再开始重构');
    }
  }

  async generatePhasePlan(options) {
    console.log('📋 正在生成重构计划...');

    const phaseIndex = options[0] ? parseInt(options[0]) - 1 : 0;
    const phase = REFACTORING_CONFIG.phases[phaseIndex];

    if (!phase) {
      console.log('❌ 指定的阶段不存在');
      console.log('可用的阶段:');
      REFACTORING_CONFIG.phases.forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.name} (${p.duration}周)`);
      });
      return;
    }

    console.log(`\n🎯 ${phase.name} 阶段详细计划`);
    console.log(`⏱️  持续时间: ${phase.duration} 周`);
    console.log(`📝 目标:`);
    phase.goals.forEach(goal => {
      console.log(`  • ${goal}`);
    });

    console.log(`\n📦 交付物:`);
    phase.keyDeliverables.forEach(deliverable => {
      console.log(`  • ${deliverable}`);
    });

    // 生成详细任务分解
    const tasks = this.generatePhaseTasks(phase);
    console.log(`\n📋 详细任务分解:`);
    tasks.forEach((task, index) => {
      console.log(`  ${index + 1}. ${task.name} (${task.duration} 天)`);
      if (task.dependencies) {
        console.log(`     依赖: ${task.dependencies.join(', ')}`);
      }
    });

    // 生成时间安排
    const schedule = this.generatePhaseSchedule(phase, tasks);
    console.log(`\n📅 时间安排:`);
    schedule.forEach((week, index) => {
      console.log(`  第${index + 1}周: ${week.join(', ')}`);
    });
  }

  async showMetrics(options) {
    console.log('📊 项目指标展示...');

    const metrics = {
      安全: {
        当前: '中等风险',
        目标: '低风险',
        进度: '0%',
        关键指标: '3个高风险漏洞需修复'
      },
      架构: {
        当前: '高耦合单体',
        目标: '松耦合微服务',
        进度: '0%',
        关键指标: '代码复杂度需降低40%'
      },
      性能: {
        当前: '基准线',
        目标: '优化50%',
        进度: '0%',
        关键指标: '响应时间和内存使用'
      },
      质量: {
        当前: '无测试覆盖',
        目标: '80%+覆盖',
        进度: '0%',
        关键指标: '单元、集成、端到端测试'
      }
    };

    console.log('\n📈 当前项目指标:');
    Object.entries(metrics).forEach(([area, data]) => {
      console.log(`\n  ${area}:`);
      console.log(`    当前状态: ${data.当前}`);
      console.log(`    目标状态: ${data.目标}`);
      console.log(`    当前进度: ${data.进度}`);
      console.log(`    关键指标: ${data.关键指标}`);
    });

    const overallProgress = 0; // 初始状态
    console.log(`\n🎯 整体进度: ${overallProgress}%`);
    console.log(`💰 预算: $${REFACTORING_CONFIG.estimatedBudget.toLocaleString()}`);
    console.log(`⏱️  预计工期: ${REFACTORING_CONFIG.estimatedDuration} 周`);
  }

  async setupEnvironment(options) {
    console.log('🔧 正在设置重构环境...');

    // 创建环境配置
    const envConfig = {
      development: {
        node: '>=16.0.0',
        packageManager: 'pnpm',
        testCommand: 'npm test',
        buildCommand: 'npm run build',
        lintCommand: 'npm run lint'
      },
      testing: {
        testCoverage: true,
        monitoring: true,
        debug: true
      },
      production: {
        optimizations: true,
        security: true,
        monitoring: true
      }
    };

    // 创建 .refactoring-env 文件
    const envContent = `# Blade 重构环境配置
REFACTORING_PHASE=1
REFACTORING_STATUS=initialized
REFACTORING_START_DATE=${new Date().toISOString()}
REFACTORING_BUDGET=${REFACTORING_CONFIG.estimatedBudget}
REFACTORING_TEAM_SIZE=${Object.values(REFACTORING_CONFIG.team).reduce((a, b) => a + b, 0)}
`;

    fs.writeFileSync('.refactoring-env', envContent);
    console.log('✅ 创建环境配置文件');

    // 检查依赖
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const requiredDeps = [
      'typescript', 'tsup', 'prettier', 'eslint', 
      'jest', '@testing-library/react', 'commander'
    ];

    const missingDeps = [];
    for (const dep of requiredDeps) {
      if (!packageJson.dependencies?.[dep] && !packageJson.devDependencies?.[dep]) {
        missingDeps.push(dep);
      }
    }

    if (missingDeps.length > 0) {
      console.log('⚠️  缺少以下依赖:');
      missingDeps.forEach(dep => console.log(`  • ${dep}`));
      console.log('\n运行以下命令安装依赖:');
      console.log(`pnpm add -D ${missingDeps.join(' ')}`);
    } else {
      console.log('✅ 所有依赖都已安装');
    }

    console.log('🎉 环境设置完成！');
  }

  async runSecurityAudit(options) {
    console.log('🔒 正在运行安全审计...');

    // 基于现有安全审计报告生成检查项
    const securityChecks = [
      {
        category: '身份认证',
        issues: [
          { level: 'high', title: 'API Key缺乏加密存储', file: 'src/config/ConfigManager.ts' },
          { level: 'medium', title: '无认证失败锁定', file: 'multiple' }
        ]
      },
      {
        category: '输入验证',
        issues: [
          { level: 'high', title: '路径遍历漏洞', file: 'src/tools/builtin/file-system.ts' },
          { level: 'high', title: '命令注入风险', file: 'src/tools/builtin/git/git-smart-commit.ts' }
        ]
      },
      {
        category: '网络安全',
        issues: [
          { level: 'medium', title: 'TLS配置未优化', file: 'src/llm/LLMManager.ts' },
          { level: 'medium', title: 'WebSocket缺乏消息验证', file: 'src/mcp/client/MCPClient.ts' }
        ]
      },
      {
        category: 'AI安全',
        issues: [
          { level: 'high', title: '提示词注入风险', file: 'src/prompt/' },
          { level: 'high', title: '执行AI生成代码风险', file: 'src/tools/builtin/smart-tools.ts' }
        ]
      }
    ];

    console.log('\n📋 安全审计结果:');
    let totalIssues = 0;
    let highRiskIssues = 0;

    securityChecks.forEach(category => {
      console.log(`\n  ${category.category}:`);
      category.issues.forEach(issue => {
        const icon = issue.level === 'high' ? '🔴' : '🟡';
        console.log(`    ${icon} ${issue.title} (${issue.file})`);
        totalIssues++;
        if (issue.level === 'high') highRiskIssues++;
      });
    });

    console.log(`\n📊 安全统计:`);
    console.log(`  总问题数: ${totalIssues}`);
    console.log(`  高风险问题: ${highRiskIssues}`);
    console.log(`  中风险问题: ${totalIssues - highRiskIssues}`);

    if (highRiskIssues > 0) {
      console.log('\n🚨 发现高风险安全问题，建议立即修复！');
    } else {
      console.log('\n✅ 安全状况良好，继续监控');
    }
  }

  async generateReport(options) {
    console.log('📊 正在生成重构报告...');

    const report = {
      timestamp: new Date().toISOString(),
      project: {
        name: 'blade-ai',
        version: '1.2.8',
        structure: 'monorepo'
      },
      assessment: {
        architecture: 'functional-but-complex',
        security: 'medium-risk',
        performance: 'baseline',
        quality: 'lacks-testing',
        documentation: 'partial'
      },
      recommendations: {
        immediate: [
          '修复高风险安全漏洞',
          '实施架构重构',
          '建立测试体系'
        ],
        shortTerm: [
          '性能优化',
          '文档完善',
          '监控部署'
        ],
        longTerm: [
          '持续集成',
          '扩展能力建设',
          '团队能力提升'
        ]
      },
      timeline: {
        totalWeeks: REFACTORING_CONFIG.estimatedDuration,
        phases: REFACTORING_CONFIG.phases,
        estimatedCompletion: new Date(Date.now() + 16 * 7 * 24 * 60 * 60 * 1000).toISOString()
      },
      resources: {
        team: REFACTORING_CONFIG.team,
        budget: REFACTORING_CONFIG.estimatedBudget,
        tools: ['TypeScript', 'Jest', 'ESLint', 'tsup', 'Docker']
      }
    };

    const reportFileName = `refactoring-report-${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(`monitoring/reports/${reportFileName}`, JSON.stringify(report, null, 2));
    console.log(`✅ 报告已生成: monitoring/reports/${reportFileName}`);

    // 生成人类可读的报告
    const humanReadableReport = this.generateHumanReadableReport(report);
    const txtFileName = `refactoring-report-${new Date().toISOString().split('T')[0]}.txt`;
    fs.writeFileSync(`monitoring/reports/${txtFileName}`, humanReadableReport);
    console.log(`✅ 可读报告已生成: monitoring/reports/${txtFileName}`);

    console.log('🎉 报告生成完成！');
  }

  async showHelp(options) {
    console.log(`
🛠️  Blade Monorepo 重构工具包

使用方法: node scripts/refactoring-toolkit.js <command> [options]

可用命令:

  init                初始化重构项目
  check               运行项目健康检查
  plan [phase]        生成指定阶段的详细计划 (1-5)
  metrics             显示项目指标
  setup              设置重构环境
  audit              运行安全审计
  report             生成重构报告
  help               显示此帮助信息

示例:
  node scripts/refactoring-toolkit.js init
  node scripts/refactoring-toolkit.js plan 1
  node scripts/refactoring-toolkit.js check
  node scripts/refactoring-toolkit.js audit

配置文件:
  config/refactoring/project.json    - 项目配置
  config/refactoring/milestones.json - 里程碑定义
  .refactoring-env                   - 环境变量

文档:
  REFACTORING_MASTER_PLAN.md         - 详细重构计划
  REFACTORING_EXECUTIVE_SUMMARY.md   - 执行摘要
`);
  }

  // 辅助方法
  generateMilestones() {
    const milestones = [];
    let weekNumber = 1;

    REFACTORING_CONFIG.phases.forEach((phase, phaseIndex) => {
      for (let i = 0; i < phase.duration; i++) {
        milestones.push({
          week: weekNumber++,
          phase: phase.id,
          phaseName: phase.name,
          phaseWeek: i + 1,
          goals: phase.goals,
          deliverables: phase.keyDeliverables,
          status: 'pending'
        });
      }
    });

    return milestones;
  }

  generatePhaseTasks(phase) {
    const taskTemplates = {
      architecture: [
        { name: 'Agent类重构', duration: 5 },
        { name: 'LLMManager实现', duration: 4, dependencies: ['Agent类重构'] },
        { name: 'ComponentManager实现', duration: 4, dependencies: ['Agent类重构'] },
        { name: '配置系统统一', duration: 3, dependencies: ['LLMManager实现', 'ComponentManager实现'] },
        { name: '代码质量标准建立', duration: 2, dependencies: ['配置系统统一'] }
      ],
      security: [
        { name: '高风险漏洞修复', duration: 3 },
        { name: '网络安全加固', duration: 2, dependencies: ['高风险漏洞修复'] },
        { name: '数据保护措施', duration: 2, dependencies: ['网络安全加固'] },
        { name: '合规性检查', duration: 1, dependencies: ['数据保护措施'] }
      ],
      performance: [
        { name: 'React-Ink UI优化', duration: 4 },
        { name: 'LLM请求优化', duration: 3, dependencies: ['React-Ink UI优化'] },
        { name: '内存优化', duration: 2, dependencies: ['React-Ink UI优化'] },
        { name: '构建优化', duration: 2, dependencies: ['LLM请求优化'] },
        { name: '监控系统部署', duration: 1, dependencies: ['构建优化'] }
      ],
      testing: [
        { name: '测试框架搭建', duration: 2 },
        { name: '单元测试实施', duration: 3, dependencies: ['测试框架搭建'] },
        { name: '集成测试实施', duration: 2, dependencies: ['单元测试实施'] },
        { name: '端到端测试实施', duration: 2, dependencies: ['集成测试实施'] },
        { name: '安全测试', duration: 1, dependencies: ['端到端测试实施'] }
      ],
      documentation: [
        { name: '技术文档编写', duration: 3 },
        { name: '用户文档编写', duration: 2, dependencies: ['技术文档编写'] },
        { name: '运维文档编写', duration: 1, dependencies: ['用户文档编写'] },
        { name: '监控系统部署', duration: 1, dependencies: ['运维文档编写'] },
        { name: '验收测试', duration: 1, dependencies: ['监控系统部署'] }
      ]
    };

    return taskTemplates[phase.id] || [];
  }

  generatePhaseSchedule(phase, tasks) {
    const schedule = Array(phase.duration).fill().map(() => []);
    const taskDurationMap = {};
    
    tasks.forEach(task => {
      taskDurationMap[task.name] = task.duration;
    });

    // 简单的任务分配算法
    let currentWeek = 0;
    tasks.forEach(task => {
      for (let i = 0; i < task.duration && currentWeek < phase.duration; i++) {
        schedule[currentWeek].push(task.name);
        currentWeek = (currentWeek + 1) % phase.duration;
      }
    });

    return schedule;
  }

  generateHumanReadableReport(report) {
    return `
Blade Monorepo 重构报告
========================

生成时间: ${new Date(report.timestamp).toLocaleString()}

项目概况
--------
项目名称: ${report.project.name}
项目版本: ${report.project.version}
项目结构: ${report.project.structure}

评估结果
--------
架构状态: ${report.assessment.architecture}
安全状态: ${report.assessment.security}
性能状态: ${report.assessment.performance}
质量状态: ${report.assessment.quality}
文档状态: ${report.assessment.documentation}

建议措施
--------
立即执行:
${report.recommendations.immediate.map(r => `  - ${r}`).join('\n')}

短期规划:
${report.recommendations.shortTerm.map(r => `  - ${r}`).join('\n')}

长期规划:
${report.recommendations.longTerm.map(r => `  - ${r}`).join('\n')}

时间安排
--------
总工期: ${report.timeline.totalWeeks} 周
预计完成: ${new Date(report.timeline.estimatedCompletion).toLocaleDateString()}

资源需求
--------
团队规模: ${Object.values(report.resources.team).reduce((a, b) => a + b, 0)} 人
预算估计: $${report.resources.budget.toLocaleString()}
主要工具: ${report.resources.tools.join(', ')}

详细的重构计划请参考:
- REFACTORING_MASTER_PLAN.md
- REFACTORING_EXECUTIVE_SUMMARY.md
`;
  }
}

// 主程序入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const toolkit = new RefactoringToolkit();
  toolkit.run(process.argv);
}

export default RefactoringToolkit;