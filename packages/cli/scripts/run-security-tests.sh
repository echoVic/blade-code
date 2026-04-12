#!/bin/bash

# 安全测试脚本

echo "Running security tests..."

# 运行 Bun 安全审计
echo "Running Bun audit..."
bun audit --audit-level=moderate

# 检查许可证
echo "Checking licenses..."
bunx license-checker --summary

# 检查过时的依赖
echo "Checking for outdated dependencies..."
bun outdated --no-progress --quiet

# 运行时检查
echo "Running runtime security checks..."
# 这里可以添加运行时安全检查命令

echo "Security tests completed."
