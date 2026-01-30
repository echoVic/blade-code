export default {
  // 发布前检查
  preChecks: {
    // 是否检查工作目录
    checkWorkingDirectory: true,
    // 是否运行测试
    runTests: false,
    // 是否检查代码质量
    checkCodeQuality: false,
    // 是否检查远程版本冲突
    checkVersionConflicts: true,
    // 是否检查安全漏洞
    checkSecurity: false,
  },
  
  // 版本管理
  version: {
    // 默认发布类型: patch, minor, major
    defaultType: 'patch',
    // 是否自动递增版本号
    autoIncrement: true,
    // 版本前缀
    tagPrefix: 'v',
  },
  
  // Changelog 配置
  changelog: {
    // 是否生成 changelog
    generate: true,
    // 文件路径（相对于 monorepo 根目录）
    file: '../../docs/changelog.md',
    // 提交分类规则
    categories: {
      feat: '✨ 新功能',
      fix: '🐛 问题修复',
      docs: '📝 文档更新',
      style: '💄 代码格式',
      refactor: '♻️ 代码重构',
      perf: '⚡ 性能优化',
      test: '✅ 测试相关',
      chore: '🔧 其他更改',
    },
  },
  
  // 构建配置
  build: {
    // 发布前是否构建
    beforePublish: true,
    // 构建命令
    command: 'npm run build',
  },
  
  // 发布配置
  publish: {
    // 是否发布到 npm
    npm: true,
    // npm 发布配置
    npmConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    },
    // 是否推送到 git
    git: true,
    // git 推送配置
    gitConfig: {
      pushTags: true,
      pushBranch: true,
    },
  },
  
  // 钩子函数
  hooks: {
    // 发布前钩子
    beforeRelease: [],
    // 发布后钩子
    afterRelease: [],
    // 失败时钩子
    onFailure: [],
  },
  
  // 通知配置
  notifications: {
    // 是否启用通知
    enabled: true,
    // 通知方式: console, discord
    methods: ['console', 'discord'],
    // Discord 配置
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1460226980938125387/5fWgMuGmkGtb6j3eoDaz4JtSFfH8LtFtHK9F2srIHGoXp71zm4sHFPCc729PujDbHJ2F',
    },
    // 通知模板
    templates: {
      success: '🎉 版本 {{version}} 发布成功！',
      failure: '❌ 版本 {{version}} 发布失败：{{error}}',
    },
  },
}; 