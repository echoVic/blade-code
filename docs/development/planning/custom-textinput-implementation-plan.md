# Custom TextInput 完整实现方案

> **状态**: 🟡 实施中
> **创建时间**: 2025-01-XX
> **相关 Issue**: 光标位置问题、粘贴支持、图片粘贴

## 背景

当前 Blade 使用 `ink-text-input` 第三方组件，存在以下问题：

1. **光标位置无法程序化控制** - @ 文件补全后光标停留在错误位置
2. **缺少粘贴检测** - 无法识别用户粘贴大段文本
3. **不支持图片粘贴** - 无法从剪贴板读取截图

经过调研，Claude Code、Gemini CLI 等主流 CLI 工具都实现了自定义 TextInput 组件。

## 目标

实现自定义 TextInput 组件，支持：

1. **程序化光标定位** - 解决 @ 文件补全后光标位置错误
2. **文本粘贴检测与处理** - 支持大段文本粘贴
3. **图片粘贴支持** - 跨平台（macOS/Linux/Windows）剪贴板图片读取

## 技术方案

### 架构选择

基于 Ink 框架：

- 使用 `useInput` hook 监听键盘事件
- 自管理文本状态和光标位置（offset-based）
- 使用 `chalk.inverse()` 渲染光标
- 支持外部控制光标位置（`cursorOffset` prop）

### 核心功能模块

#### 1. 基础编辑功能（~100 行）

- 字符输入、删除（Backspace/Delete）
- 左右移动（Arrow keys）
- Home/End 快捷键
- Ctrl+A（全选）、Ctrl+K（删除到行尾）
- Ctrl+W（删除单词）

#### 2. 光标控制（~50 行）

```typescript
interface CursorControl {
  cursorOffset: number; // 外部控制光标位置
  onChangeCursorOffset: (offset: number) => void; // 通知外部光标变化
}
```

**特性**：
- 支持外部设置光标位置
- 自动处理中文等多字节字符
- 与 @ 补全、/ 命令补全集成

#### 3. 文本粘贴检测（~150 行）

##### 检测策略

```typescript
const PASTE_CONFIG = {
  TIMEOUT_MS: 100, // chunk 合并超时
  RAPID_INPUT_THRESHOLD_MS: 150, // 快速输入阈值
  LARGE_INPUT_THRESHOLD: 300, // 大文本阈值
  MEDIUM_SIZE_MULTI_CHUNK_THRESHOLD: 200, // 中等文本阈值
};
```

##### 粘贴检测条件

```typescript
const isPaste =
  input.length > 300 || // 大段文本
  input.includes('\n') || // 多行
  (timeSinceFirst < 150 && chunks.length > 0); // 快速连续
```

##### 回调接口

```typescript
onPaste?: (text: string) => Promise<{ prompt?: string }> | void;
```

##### 分片合并机制

```typescript
const pasteState = {
  chunks: [], // 收集的文本片段
  timeoutId: null, // 超时 ID
  firstInputTime: null, // 首次输入时间
  totalLength: 0, // 总字符数
};
```

#### 4. 图片粘贴支持（~400 行）

##### 4.1 跨平台剪贴板读取

**macOS**:

```bash
# 检查剪贴板有图片
osascript -e 'the clipboard as «class PNGf»'

# 保存到临时文件
osascript -e 'set png_data to (the clipboard as «class PNGf»)' \
  -e 'set fp to open for access POSIX file "/tmp/blade_screenshot.png" with write permission' \
  -e 'write png_data to fp' \
  -e 'close access fp'
```

**Linux**:

```bash
# 检查剪贴板有图片
xclip -selection clipboard -t TARGETS -o | grep -E "image/"

# 保存到临时文件 (X11)
xclip -selection clipboard -t image/png -o > /tmp/blade_screenshot.png

# 或使用 wl-paste (Wayland)
wl-paste --type image/png > /tmp/blade_screenshot.png
```

**Windows**:

```powershell
# 检查剪贴板有图片
powershell -Command "(Get-Clipboard -Format Image) -ne $null"

# 保存到临时文件
powershell -Command "$img = Get-Clipboard -Format Image; if ($img) { $img.Save('C:\\Temp\\blade_screenshot.png', [System.Drawing.Imaging.ImageFormat]::Png) }"
```

##### 4.2 图片类型检测（基于二进制头）

```typescript
function detectImageType(base64Data: string): string {
  const buffer = Buffer.from(base64Data, 'base64');

  // PNG: 137, 80, 78, 71
  if (buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) {
    return 'image/png';
  }

  // JPEG: 255, 216, 255
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return 'image/jpeg';
  }

  // GIF: 71, 73, 70
  if (buffer[0] === 71 && buffer[1] === 73 && buffer[2] === 70) {
    return 'image/gif';
  }

  // WebP: RIFF...WEBP
  if (buffer[0] === 82 && buffer[1] === 73 && buffer[2] === 70 && buffer[3] === 70) {
    if (buffer[8] === 87 && buffer[9] === 69 && buffer[10] === 66 && buffer[11] === 80) {
      return 'image/webp';
    }
  }

  return 'image/png'; // 默认
}
```

##### 4.3 图片路径粘贴处理

当用户粘贴 `image.png` 或 `/path/to/image.jpg` 时：

1. 检测是否为图片路径格式（扩展名匹配）
2. 读取文件并转换为 base64
3. 调用 `onImagePaste` 回调

```typescript
async function processImageFromPath(path: string): Promise<{
  base64: string;
  mediaType: string;
  filename: string;
} | null> {
  if (!isImagePath(path)) return null;

  const imageData = readFileSync(path);
  const base64 = imageData.toString('base64');
  const mediaType = detectImageType(base64);

  return { base64, mediaType, filename: basename(path) };
}
```

##### 4.4 回调接口

```typescript
onImagePaste?: (
  base64Image: string,
  mediaType: string,
  filename?: string,
) => Promise<{ prompt?: string }> | void;
```

**使用场景**：

- 用户按下 Cmd+V 粘贴图片 → 调用 `onImagePaste`
- Blade 将图片上传到 LLM（或保存到本地）
- 返回 `{ prompt: "已添加图片 image.png" }`，插入到输入框

#### 5. 集成现有功能（~50 行）

- @ 文件补全（已有 `useAtCompletion`）
- / 命令补全（已有 `useSlashCommandCompletion`）
- Tab 键触发补全

## 实施步骤

### 第一步：创建图片粘贴工具模块

**文件**: `src/ui/utils/imagePaste.ts` (~400 行)

**核心函数**：

```typescript
// 1. 从剪贴板读取图片
export async function getImageFromClipboard(): Promise<{
  base64: string;
  mediaType: string;
} | null>;

// 2. 从文件路径读取图片
export async function processImageFromPath(path: string): Promise<{
  base64: string;
  mediaType: string;
  filename: string;
} | null>;

// 3. 检测图片类型
export function detectImageType(base64Data: string): string;

// 4. 判断是否为图片路径
export function isImagePath(text: string): boolean;
```

**跨平台命令配置**：

```typescript
const PLATFORM_COMMANDS = {
  darwin: {
    checkImage: "osascript -e 'the clipboard as «class PNGf»'",
    saveImage: (path) => `osascript -e '...'`,
    deleteFile: (path) => `rm -f "${path}"`,
  },
  linux: {
    checkImage: 'xclip -selection clipboard -t TARGETS -o | grep "image/"',
    saveImage: (path) => `xclip -selection clipboard -t image/png -o > "${path}"`,
    deleteFile: (path) => `rm -f "${path}"`,
  },
  win32: {
    checkImage: 'powershell -Command "(Get-Clipboard -Format Image) -ne $null"',
    saveImage: (path) => `powershell -Command "..."`,
    deleteFile: (path) => `del /f "${path}"`,
  },
};
```

### 第二步：创建自定义 TextInput 组件

**文件**: `src/ui/components/CustomTextInput.tsx` (~400 行)

**组件接口**：

```typescript
interface CustomTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;

  // 文本粘贴
  onPaste?: (text: string) => Promise<{ prompt?: string }> | void;

  // 图片粘贴
  onImagePaste?: (
    base64: string,
    mediaType: string,
    filename?: string,
  ) => Promise<{ prompt?: string }> | void;

  placeholder?: string;
  focus?: boolean;
}
```

**核心逻辑**：

```typescript
export function CustomTextInput(props: CustomTextInputProps) {
  // 1. 粘贴检测状态
  const pasteStateRef = useRef({
    chunks: [],
    timeoutId: null,
    firstInputTime: null,
    totalLength: 0,
  });

  // 2. 键盘输入处理
  const handleInput = async (input: string, key: Key) => {
    // 2.1 检测是否为粘贴
    const isPasteCandidate =
      input.length > 300 || input.includes('\n') || (timeSinceFirst < 150 && chunks.length > 0);

    if (isPasteCandidate) {
      // 收集 chunk
      pasteStateRef.current.chunks.push(input);
      processPendingChunks(); // 延迟处理
      return;
    }

    // 2.2 正常输入
    processNormalInput(input, key);
  };

  // 3. 处理粘贴内容
  const processPendingChunks = () => {
    setTimeout(async () => {
      const mergedInput = chunks.join('');

      // 3.1 检测是否为图片路径
      if (props.onImagePaste && isImagePath(mergedInput)) {
        const imageResult = await processImageFromPath(mergedInput);
        if (imageResult) {
          const result = await props.onImagePaste(
            imageResult.base64,
            imageResult.mediaType,
            imageResult.filename,
          );
          if (result?.prompt) {
            insertText(result.prompt);
          }
          return;
        }
      }

      // 3.2 处理文本粘贴
      if (props.onPaste) {
        const result = await props.onPaste(mergedInput);
        if (result?.prompt) {
          insertText(result.prompt);
          return;
        }
      }

      // 3.3 直接插入文本
      insertText(mergedInput);
    }, PASTE_CONFIG.TIMEOUT_MS);
  };

  // 4. 注册 Ink 输入监听
  useInput(handleInput, { isActive: props.focus });

  // 5. 渲染文本和光标
  const renderedValue = renderWithCursor(props.value, props.cursorOffset);
  return <Text>{renderedValue}</Text>;
}
```

### 第三步：添加配置

**文件**: `src/ui/constants.ts`

```typescript
export const PASTE_CONFIG = {
  TIMEOUT_MS: 100,
  RAPID_INPUT_THRESHOLD_MS: 150,
  LARGE_INPUT_THRESHOLD: 300,
  MEDIUM_SIZE_MULTI_CHUNK_THRESHOLD: 200,
} as const;
```

### 第四步：修改状态管理

**文件**: `src/ui/contexts/SessionContext.tsx`

```typescript
export interface SessionState {
  // ... 其他字段
  cursorOffset: number; // 🆕 光标偏移量
}

// 添加 action
| { type: 'SET_CURSOR_OFFSET'; payload: number }

// reducer
case 'SET_CURSOR_OFFSET':
  return { ...state, cursorOffset: action.payload };

case 'SET_INPUT':
  return {
    ...state,
    input: action.payload,
    cursorOffset: action.payload.length, // 默认移到末尾
  };
```

### 第五步：集成到主输入组件

**文件**: `src/ui/components/MainInput.tsx`

```typescript
import { CustomTextInput } from './CustomTextInput';
import { getImageFromClipboard } from '../utils/imagePaste';

<CustomTextInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  cursorOffset={sessionState.cursorOffset}
  onChangeCursorOffset={(offset) => dispatch({ type: 'SET_CURSOR_OFFSET', payload: offset })}
  // 文本粘贴回调
  onPaste={async (text) => {
    console.log(`Pasted ${text.length} characters`);
    // 可选：弹提示或处理大段文本
  }}
  // 图片粘贴回调
  onImagePaste={async (base64, mediaType, filename) => {
    // TODO: 实现图片上传到 LLM 或保存到本地
    console.log(`Pasted image: ${filename} (${mediaType})`);

    // 示例：返回提示文本
    return { prompt: `[Image: ${filename}] ` };
  }}
  placeholder="Ask anything..."
  focus={true}
/>;
```

### 第六步：更新 @ 补全逻辑

**文件**: `src/ui/hooks/useMainInput.ts`

```typescript
// 使用 cursorOffset
const atCompletion = useAtCompletion(input, sessionState.cursorOffset, {
  cwd: process.cwd(),
  maxSuggestions: 10,
});

// 应用补全时更新 offset
const { newInput, newCursorPos } = applySuggestion(/* ... */);
dispatch({ type: 'SET_CURSOR_OFFSET', payload: newCursorPos });
```

## 测试验证

### 功能测试

1. ✅ @ 文件补全后光标正确定位
2. ✅ 基础编辑（输入、删除、移动）
3. ✅ 粘贴大段文本正确处理
4. ✅ 粘贴图片路径（如 `image.png`）
5. ✅ 从剪贴板粘贴屏幕截图（Cmd+Ctrl+Shift+4）
6. ✅ / 命令补全正常工作

### 跨平台测试

1. ✅ macOS: 截图快捷键 Cmd+Ctrl+Shift+4
2. ✅ Linux: xclip / wl-paste
3. ✅ Windows: PowerShell Get-Clipboard

### 边界测试

1. ✅ 中文输入和光标定位
2. ✅ Emoji 等多字节字符
3. ✅ 粘贴包含换行的文本
4. ✅ 快速连续输入（模拟粘贴分片）
5. ✅ 剪贴板无图片时正常处理

## 预估工作量

- imagePaste.ts 工具模块：2-3 小时
- CustomTextInput 组件：2-3 小时
- 状态管理修改：0.5 小时
- 集成和替换现有组件：1 小时
- 跨平台测试和调试：2-3 小时
- **总计：7.5-10.5 小时**

## 后续优化（可选）

- 图片上传到 LLM 服务
- 图片本地缓存管理
- 图片压缩（减少 token 消耗）
- 支持多图片粘贴
- 粘贴进度提示

## 参考实现

- [Claude Code - Custom Input](https://github.com/anthropics/claude-code)
- [Gemini CLI - Text Buffer](https://github.com/google/generative-ai-cli)

## 版本历史

- **v1.0** (2025-01-XX): 初版方案
