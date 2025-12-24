import { useMemoizedFn } from 'ahooks';
import { Box, Text } from 'ink';
import React from 'react';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import {
  createPasteMarkerStart,
  getPasteMarkerEnd,
} from '../hooks/useInputBuffer.js';
import { CustomTextInput } from './CustomTextInput.js';

interface InputAreaProps {
  input: string;
  cursorPosition: number;
  onChange: (value: string) => void;
  onChangeCursorPosition: (position: number) => void;
  /** 添加文本粘贴映射，返回标记 ID */
  onAddPasteMapping: (original: string) => number;
  /** 添加图片粘贴映射，返回标记 ID */
  onAddImagePasteMapping: (base64: string, mimeType: string) => number;
}

/**
 * 输入区域组件
 * 使用 CustomTextInput 组件处理光标、编辑、粘贴和图片
 * 注意：加载动画已移至 LoadingIndicator 组件，显示在输入框上方
 */
export const InputArea: React.FC<InputAreaProps> = React.memo(
  ({
    input,
    cursorPosition,
    onChange,
    onChangeCursorPosition,
    onAddPasteMapping,
    onAddImagePasteMapping,
  }) => {
    // 使用 Zustand store 管理焦点
    const currentFocus = useCurrentFocus();
    const isFocused = currentFocus === FocusId.MAIN_INPUT;

    // 文本粘贴回调 - 处理大段文本粘贴
    // 显示摘要标记，但保存原文用于提交时替换
    const handlePaste = useMemoizedFn((text: string): { prompt?: string } => {
      const lineCount = text.split('\n').length;
      const charCount = text.length;

      // 根据文本大小决定是否显示摘要
      const SUMMARY_THRESHOLD_CHARS = 500;
      const SUMMARY_THRESHOLD_LINES = 10;

      if (charCount > SUMMARY_THRESHOLD_CHARS || lineCount > SUMMARY_THRESHOLD_LINES) {
        // 添加映射并获取标记 ID
        const id = onAddPasteMapping(text);

        // 生成摘要信息
        const preview = text.slice(0, 30).replace(/\n/g, ' ');
        const summary = `${charCount} chars, ${lineCount} lines: ${preview}...`;

        // 构建完整标记：␞PASTE:id:摘要内容␟
        // 整个标记会在提交时被替换为原文
        const displayText = `${createPasteMarkerStart(id)}${summary}${getPasteMarkerEnd()}`;

        return { prompt: displayText };
      }

      // 小文本直接插入，不做处理
      return {};
    });

    // 图片粘贴回调 - 处理图片粘贴（路径或剪贴板）
    // 使用粘贴标记系统存储图片数据，提交时构建多模态消息
    const handleImagePaste = useMemoizedFn(
      async (
        base64: string,
        mediaType: string,
        _filename?: string
      ): Promise<{ prompt?: string }> => {
        try {
          // 添加图片映射并获取标记 ID
          const id = onAddImagePasteMapping(base64, mediaType);

          // 构建显示标记：␞PASTE:id:[Image #N]␟
          // 提交时会识别图片类型，构建多模态消息
          const displayText = `${createPasteMarkerStart(id)}[Image #${id}]${getPasteMarkerEnd()}`;

          return { prompt: displayText };
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
        width="100%"
        paddingX={2}
        paddingY={0}
        flexShrink={0}
        flexGrow={0}
        overflow="hidden"
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
