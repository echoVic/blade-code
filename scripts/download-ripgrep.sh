#!/bin/bash

# 下载并安装所有平台的 ripgrep 二进制文件
# 用法: ./scripts/download-ripgrep.sh [版本号]

set -e

VERSION="${1:-14.1.0}"
BASE_URL="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}"
VENDOR_DIR="vendor/ripgrep"

echo "📦 开始下载 ripgrep v${VERSION} 所有平台的二进制文件..."
echo ""

# 创建 vendor 目录
mkdir -p "${VENDOR_DIR}"

# 定义平台映射: ripgrep平台名:blade平台目录名:二进制名
PLATFORMS=(
  "x86_64-apple-darwin:darwin-x64:rg"
  "aarch64-apple-darwin:darwin-arm64:rg"
  "x86_64-unknown-linux-musl:linux-x64:rg"
  "aarch64-unknown-linux-gnu:linux-arm64:rg"
  "x86_64-pc-windows-msvc:win32-x64:rg.exe"
)

# 下载并解压每个平台的二进制文件
for platform in "${PLATFORMS[@]}"; do
  IFS=':' read -r rg_platform blade_platform binary_name <<< "$platform"

  echo "⏬ 正在下载 ${blade_platform} (${rg_platform})..."

  # 确定压缩包格式
  if [[ $blade_platform == win32-* ]]; then
    ARCHIVE="ripgrep-${VERSION}-${rg_platform}.zip"
  else
    ARCHIVE="ripgrep-${VERSION}-${rg_platform}.tar.gz"
  fi

  # 下载文件
  DOWNLOAD_URL="${BASE_URL}/${ARCHIVE}"
  TEMP_FILE="/tmp/${ARCHIVE}"

  if command -v curl &> /dev/null; then
    curl -L -o "${TEMP_FILE}" "${DOWNLOAD_URL}" --progress-bar
  elif command -v wget &> /dev/null; then
    wget -q --show-progress "${DOWNLOAD_URL}" -O "${TEMP_FILE}"
  else
    echo "❌ 错误: 需要 curl 或 wget 来下载文件"
    exit 1
  fi

  # 创建目标目录
  TARGET_DIR="${VENDOR_DIR}/${blade_platform}"
  mkdir -p "${TARGET_DIR}"

  # 解压文件
  echo "📂 正在解压到 ${TARGET_DIR}..."
  if [[ $blade_platform == win32-* ]]; then
    # Windows 平台使用 zip
    if command -v unzip &> /dev/null; then
      unzip -j -o "${TEMP_FILE}" "ripgrep-${VERSION}-${rg_platform}/${binary_name}" \
        -d "${TARGET_DIR}/" > /dev/null
    else
      echo "❌ 错误: 需要 unzip 来解压 Windows 文件"
      rm "${TEMP_FILE}"
      continue
    fi
  else
    # Unix 平台使用 tar.gz
    tar -xzf "${TEMP_FILE}" --strip-components=1 \
      -C "${TARGET_DIR}/" \
      "ripgrep-${VERSION}-${rg_platform}/${binary_name}"
  fi

  # 设置执行权限（Unix 平台）
  if [[ $blade_platform != win32-* ]]; then
    chmod +x "${TARGET_DIR}/${binary_name}"
  fi

  # 清理临时文件
  rm "${TEMP_FILE}"

  echo "✅ ${blade_platform} 下载完成"
  echo ""
done

echo "🎉 所有平台的 ripgrep 二进制文件下载完成！"
echo ""
echo "📍 文件位置:"
find "${VENDOR_DIR}" -name "rg*" -type f | while read -r file; do
  size=$(du -h "$file" | cut -f1)
  echo "  - $file ($size)"
done
echo ""
echo "💡 提示: 这些文件将被包含在 npm 包中，确保它们有正确的权限。"
