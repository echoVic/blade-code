# 覆盖率配置说明

## 覆盖率目标

Blade 项目采用分层覆盖率策略，确保不同模块的测试质量：

### 全局目标
- **分支覆盖率**: 80%
- **函数覆盖率**: 80%
- **行覆盖率**: 80%
- **语句覆盖率**: 80%

### 分层目标

#### Core 包 (`@blade-ai/core`)
- **分支覆盖率**: 85%
- **函数覆盖率**: 85%
- **行覆盖率**: 85%
- **语句覆盖率**: 85%
- **理由**: 核心业务逻辑，需要最高的测试覆盖

#### UI 包 (`@blade-ai/ui`)
- **分支覆盖率**: 75%
- **函数覆盖率**: 75%
- **行覆盖率**: 75%
- **语句覆盖率**: 75%
- **理由**: UI组件测试相对复杂，允许稍低的覆盖率

#### 根目录 (`src/`)
- **分支覆盖率**: 70%
- **函数覆盖率**: 70%
- **行覆盖率**: 70%
- **语句覆盖率**: 70%
- **理由**: 主要包含CLI入口和工具函数

## 覆盖率工具配置

### Jest 覆盖率
```json
{
  "collectCoverageFrom": [
    "src/**/*.{ts,tsx}",
    "packages/*/src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!packages/*/src/**/*.d.ts",
    "!src/**/index.ts",
    "!packages/*/src/**/index.{ts,tsx}"
  ],
  "coverageThreshold": {
    "global": {
      "branches": 80,
      "functions": 80,
      "lines": 80,
      "statements": 80
    }
  }
}
```

### NYC (Istanbul) 覆盖率
```json
{
  "check-coverage": true,
  "branches": 80,
  "functions": 80,
  "lines": 80,
  "statements": 80
}
```

## 覆盖率报告格式

项目支持多种覆盖率报告格式：

1. **文本格式** (`text`) - 控制台输出
2. **LCOV 格式** (`lcov`) - 代码编辑器集成
3. **HTML 格式** (`html`) - 可视化报告
4. **团队城市格式** (`teamcity`) - CI/CD 集成
5. **JSON 摘要** (`json-summary`) - 自动化处理

## 覆盖率检查和执行

### 运行覆盖率测试
```bash
# 完整覆盖率测试
npm run test:coverage

# 仅核心包覆盖率
npm run test:core -- --coverage

# 仅UI包覆盖率
npm run test:ui -- --coverage

# CI/CD 环境覆盖率测试
npm run test:ci
```

### 覆盖率阈值检查
```bash
# 检查覆盖率是否达标
npx nyc check-coverage

# 生成详细覆盖率报告
npx nyc report --reporter=html
```

## 覆盖率排除规则

### 自动排除的文件
- 类型定义文件 (`*.d.ts`)
- 测试文件 (`*.test.*`, `*.spec.*`)
- 配置文件 (`*.config.*`)
- 示例文件 (`*.example.*`)
- 故事文件 (`*.stories.*`)
- 构建输出文件 (`dist/`, `build/`)
- 依赖目录 (`node_modules/`)
- 覆盖率报告目录 (`coverage/`)

### 手动排除规则
```typescript
// 在代码中使用注释排除特定代码块
if (process.env.NODE_ENV === 'production') {
  /* istanbul ignore next */
  console.log('Production mode');
}

// 或者在配置中排除特定文件
{
  "coveragePathIgnorePatterns": [
    "src/deprecated/.*",
    "src/temp/.*"
  ]
}
```

## 覆盖率监控

### 持续集成
- GitHub Actions 自动运行覆盖率测试
- 覆盖率报告自动上传到 Codecov
- 覆盖率下降会阻止合并

### 本地开发
- 使用 `npm run test:coverage` 生成本地报告
- 在 `coverage/lcov-report/index.html` 查看详细报告

### 覆盖率趋势分析
- 跟踪覆盖率变化趋势
- 识别覆盖率下降的模块
- 制定测试覆盖率提升计划

## 覆盖率最佳实践

### 1. 持续监控
- 定期检查覆盖率报告
- 设置覆盖率下降告警
- 建立覆盖率基线

### 2. 优先级策略
- 核心业务逻辑优先
- 高风险代码优先
- 频繁修改代码优先

### 3. 质量保障
- **高覆盖率 + 高质量测试** = 最佳状态
- **高覆盖率 + 低质量测试** = 危险状态
- 结合代码审查确保测试质量

### 4. 工具链集成
- 编辑器实时显示覆盖率
- 预提交钩子检查覆盖率
- CI/CD 管道强制覆盖率标准

## 覆盖率故障排除

### 常见问题
1. **覆盖率未生成**：检查文件路径和排除规则
2. **覆盖率偏低**：检查测试用例覆盖程度
3. **覆盖率不稳定**：检查测试用例稳定性

### 调试命令
```bash
# 详细覆盖率输出
npm run test:coverage -- --verbose

# 排除特定文件检查覆盖率
npx nyc --exclude="src/utils/**" npm test

# 生成调试信息
npx nyc report --reporter=text-lcov | npx codecov
```