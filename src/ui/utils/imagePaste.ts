/**
 * 图片粘贴工具模块
 *
 * 提供跨平台的剪贴板图片读取功能，支持：
 * - macOS: osascript
 * - Linux: xclip / wl-paste
 * - Windows: PowerShell
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

/**
 * 根据平台返回剪贴板错误提示信息
 */
function getClipboardErrorMessage(): string {
  const platform = process.platform;
  const messages = {
    darwin:
      'No image found in clipboard. Use Cmd + Ctrl + Shift + 4 to copy a screenshot to clipboard.',
    win32:
      'No image found in clipboard. Use Print Screen to copy a screenshot to clipboard.',
    linux:
      'No image found in clipboard. Use appropriate screenshot tool to copy a screenshot to clipboard.',
  };
  return messages[platform as keyof typeof messages] || messages.linux;
}

export const CLIPBOARD_ERROR_MESSAGE = getClipboardErrorMessage();

/**
 * 基于二进制头检测图片类型（比 base64 前缀更可靠）
 */
export function detectImageType(base64Data: string): string {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 4) return 'image/png';

    // PNG 文件头: 137, 80, 78, 71
    if (buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) {
      return 'image/png';
    }

    // JPEG 文件头: 255, 216, 255
    if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
      return 'image/jpeg';
    }

    // GIF 文件头: 71, 73, 70
    if (buffer[0] === 71 && buffer[1] === 73 && buffer[2] === 70) {
      return 'image/gif';
    }

    // WebP 文件头: RIFF...WEBP
    if (buffer[0] === 82 && buffer[1] === 73 && buffer[2] === 70 && buffer[3] === 70) {
      if (
        buffer.length >= 12 &&
        buffer[8] === 87 &&
        buffer[9] === 69 &&
        buffer[10] === 66 &&
        buffer[11] === 80
      ) {
        return 'image/webp';
      }
    }

    return 'image/png'; // 默认类型
  } catch {
    return 'image/png';
  }
}

/**
 * 跨平台命令配置
 */
function getPlatformCommands() {
  const platform = process.platform;
  const tempPathMapping = {
    darwin: '/tmp/blade_cli_latest_screenshot.png',
    linux: '/tmp/blade_cli_latest_screenshot.png',
    win32: process.env.TEMP
      ? `${process.env.TEMP}\\blade_cli_latest_screenshot.png`
      : 'C:\\Temp\\blade_cli_latest_screenshot.png',
  };

  const commandMapping = {
    darwin: {
      checkImage: "osascript -e 'the clipboard as «class PNGf»'",
      saveImage: (path: string) =>
        `osascript -e 'set png_data to (the clipboard as «class PNGf»)' -e 'set fp to open for access POSIX file "${path}" with write permission' -e 'write png_data to fp' -e 'close access fp'`,
      getPath: "osascript -e 'get POSIX path of (the clipboard as «class furl»)'",
      deleteFile: (path: string) => `rm -f "${path}"`,
    },
    linux: {
      checkImage:
        'xclip -selection clipboard -t TARGETS -o | grep -E "image/(png|jpeg|jpg|gif|webp)"',
      saveImage: (path: string) =>
        `xclip -selection clipboard -t image/png -o > "${path}" || wl-paste --type image/png > "${path}"`,
      getPath: 'xclip -selection clipboard -t text/plain -o',
      deleteFile: (path: string) => `rm -f "${path}"`,
    },
    win32: {
      checkImage: 'powershell -Command "(Get-Clipboard -Format Image) -ne $null"',
      saveImage: (path: string) =>
        `powershell -Command "$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${path.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
      getPath: 'powershell -Command "Get-Clipboard"',
      deleteFile: (path: string) => `del /f "${path}"`,
    },
  };

  return {
    commands:
      commandMapping[platform as keyof typeof commandMapping] || commandMapping.linux,
    screenshotPath:
      tempPathMapping[platform as keyof typeof tempPathMapping] ||
      tempPathMapping.linux,
  };
}

/**
 * 获取剪贴板路径（用于相对图片路径解析）
 */
function getClipboardPath(): string | null {
  const { commands } = getPlatformCommands();
  try {
    return execSync(commands.getPath, { encoding: 'utf-8' }).trim();
  } catch (error) {
    console.error('Failed to get clipboard path:', error);
    return null;
  }
}

/**
 * 移除路径两端的引号
 */
function removeQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * 处理转义字符（Unix/Linux 路径）
 */
function processEscapeCharacters(path: string): string {
  if (process.platform === 'win32') return path;

  const doubleBackslashPlaceholder = '__DOUBLE_BACKSLASH__';
  return path
    .replace(/\\\\/g, doubleBackslashPlaceholder)
    .replace(/\\(.)/g, '$1')
    .replace(new RegExp(doubleBackslashPlaceholder, 'g'), '\\');
}

/**
 * 检查文本是否匹配图片路径格式
 */
export function isImagePath(text: string): boolean {
  const cleanedText = removeQuotes(text.trim());
  const processedPath = processEscapeCharacters(cleanedText);
  const imageExtensionRegex = /\.(png|jpe?g|gif|webp)$/i;
  return imageExtensionRegex.test(processedPath);
}

/**
 * 从文本中提取并验证图片路径
 */
function extractImagePath(text: string): string | null {
  const cleanedText = removeQuotes(text.trim());
  const processedPath = processEscapeCharacters(cleanedText);
  if (isImagePath(processedPath)) return processedPath;
  return null;
}

/**
 * 从文件路径处理图片粘贴
 *
 * @param pasteContent 粘贴的文本内容（可能是图片路径）
 * @returns 图片信息或 null
 */
export async function processImageFromPath(pasteContent: string): Promise<{
  base64: string;
  mediaType: string;
  path: string;
  filename: string;
} | null> {
  const imagePath = extractImagePath(pasteContent);
  if (!imagePath) return null;

  let imageData: Buffer;
  try {
    if (isAbsolute(imagePath)) {
      // 绝对路径直接读取
      imageData = readFileSync(imagePath);
    } else {
      // 相对路径，结合剪贴板路径
      const clipboardPath = getClipboardPath();
      if (clipboardPath && imagePath === basename(clipboardPath)) {
        imageData = readFileSync(clipboardPath);
      } else {
        return null;
      }
    }
  } catch (error) {
    console.error('Failed to read image file:', error);
    return null;
  }

  const base64Data = imageData.toString('base64');
  const mediaType = detectImageType(base64Data);
  const filename = basename(imagePath);

  return { path: imagePath, base64: base64Data, mediaType, filename };
}

/**
 * 增强的跨平台剪贴板图片获取
 *
 * @returns 图片的 base64 和 MIME 类型，或 null
 */
export async function getImageFromClipboard(): Promise<{
  base64: string;
  mediaType: string;
} | null> {
  const { commands, screenshotPath } = getPlatformCommands();

  try {
    // 1. 检查剪贴板是否包含图片
    execSync(commands.checkImage, { stdio: 'ignore' });

    // 2. 保存图片到临时文件
    execSync(commands.saveImage(screenshotPath), { stdio: 'ignore' });

    // 3. 验证文件是否成功创建
    if (!existsSync(screenshotPath)) {
      return null;
    }

    // 4. 读取图片文件并转换为 base64
    const imageBytes = readFileSync(screenshotPath);
    const base64Data = imageBytes.toString('base64');
    const mediaType = detectImageType(base64Data);

    // 5. 清理临时文件
    execSync(commands.deleteFile(screenshotPath), { stdio: 'ignore' });

    return { base64: base64Data, mediaType };
  } catch (_error) {
    // 清理可能存在的临时文件
    try {
      execSync(commands.deleteFile(screenshotPath), { stdio: 'ignore' });
    } catch {
      // 忽略清理错误
    }

    return null;
  }
}
