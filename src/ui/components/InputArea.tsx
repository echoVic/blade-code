import { useMemoizedFn } from 'ahooks';
import { Box, Text } from 'ink';
import React from 'react';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { saveImageToTemp } from '../utils/imageHandler.js';
import { CustomTextInput } from './CustomTextInput.js';

interface InputAreaProps {
  input: string;
  cursorPosition: number;
  onChange: (value: string) => void;
  onChangeCursorPosition: (position: number) => void;
}

/**
 * 输入区域组件
 * 使用 CustomTextInput 组件处理光标、编辑、粘贴和图片
 * 注意：加载动画已移至 LoadingIndicator 组件，显示在输入框上方
 */
export const InputArea: React.FC<InputAreaProps> = React.memo(
  ({ input, cursorPosition, onChange, onChangeCursorPosition }) => {
    // 使用 Zustand store 管理焦点
    const currentFocus = useCurrentFocus();
    const isFocused = currentFocus === FocusId.MAIN_INPUT;

    // 文本粘贴回调 - 处理大段文本粘贴
    const handlePaste = useMemoizedFn((text: string): { prompt?: string } => {
      const lineCount = text.split('\n').length;
      const charCount = text.length;

      // 根据文本大小决定是否显示摘要
      const SUMMARY_THRESHOLD_CHARS = 500;
      const SUMMARY_THRESHOLD_LINES = 10;

      if (charCount > SUMMARY_THRESHOLD_CHARS || lineCount > SUMMARY_THRESHOLD_LINES) {
        // 生成摘要：显示前 30 个字符 + 统计信息
        const preview = text.slice(0, 30).replace(/\n/g, ' ');
        const summary = `[Pasted: ${charCount} chars, ${lineCount} lines] ${preview}...`;
        return { prompt: summary };
      }

      // 小文本直接插入，不做处理
      return {};
    });

    // 图片粘贴回调 - 处理图片粘贴（路径或剪贴板）
    const handleImagePaste = useMemoizedFn(
      async (
        base64: string,
        mediaType: string,
        filename?: string
      ): Promise<{ prompt?: string }> => {
        try {
          // 保存图片到临时目录
          const result = saveImageToTemp(base64, mediaType, filename);

          // TODO: 未来需要实现图片处理逻辑
          //
          // 问题：当前的 @ 引用机制只支持文本文件
          // AttachmentCollector.readFile() 会用 fs.readFile(path, 'utf-8')
          // 读取图片会失败："Cannot read file as text. It may be a binary file."
          //
          // 解决方案（三选一）：
          //
          // 方案1：扩展 AttachmentCollector 支持图片
          //   - 检测文件扩展名，如果是图片则读取为 base64
          //   - 在 Message 中添加图片附件支持
          //   - 修改 ChatService 将图片发送给 LLM
          //   优点：符合 Blade 架构，图片作为附件发送
          //   缺点：需要修改多个模块
          //
          // 方案2：直接将 base64 嵌入 prompt
          //   - 返回 data URI 格式：`data:image/png;base64,${base64}`
          //   - 但这会使 prompt 非常长，且不是所有 LLM 都支持
          //   优点：简单直接
          //   缺点：token 消耗大，兼容性问题
          //
          // 方案3：先上传到图床/对象存储，返回 URL
          //   - 调用图床 API 上传图片
          //   - 获取公网 URL
          //   - 返回 URL 给 LLM
          //   优点：不占用 prompt 空间
          //   缺点：需要外部服务，有网络依赖
          //
          // 当前实现（临时方案）：
          // 返回 @"文件路径"，但会失败，因为 @ 机制不支持二进制文件
          // 这只是占位符，提醒用户图片已保存，需要手动处理

          return {
            prompt: `[Image saved to ${result.filePath}. Note: Image attachments not yet supported by @ mentions] `,
          };
        } catch (error) {
          console.error(`[Image Paste] Failed to process image:`, error);
          return {
            prompt: `[Image paste failed: ${error instanceof Error ? error.message : 'Unknown error'}] `,
          };
        }
      }
    );

    return (
      <Box
        flexDirection="row"
        paddingX={2}
        paddingY={0}
        borderStyle="round"
        borderColor="gray"
      >
        <Text color="blue" bold>
          {'> '}
        </Text>
        <CustomTextInput
          value={input}
          cursorPosition={cursorPosition}
          onChange={onChange}
          onChangeCursorPosition={onChangeCursorPosition}
          onPaste={handlePaste}
          onImagePaste={handleImagePaste}
          placeholder=" 输入命令..."
          focus={isFocused}
          disabledKeys={['upArrow', 'downArrow', 'tab', 'return', 'escape']}
        />
      </Box>
    );
  }
);
