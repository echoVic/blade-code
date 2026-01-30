#!/bin/bash

# 安全测试脚本

echo "Running security tests..."

# 运行 npm 安全审计
echo "Running npm audit..."
pnpm audit --audit-level=moderate

# 检查许可证
echo "Checking licenses..."
pnpm licenses list

# 检查过时的依赖
echo "Checking for outdated dependencies..."
pnpm outdated

# 运行时检查
echo "Running runtime security checks..."
# 这里可以添加运行时安全检查命令

echo "Security tests completed."

