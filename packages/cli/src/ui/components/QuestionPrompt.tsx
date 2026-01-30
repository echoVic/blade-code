import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import React, { useCallback, useMemo, useState } from 'react';
import { useCurrentFocus } from '../../store/selectors/index.js';
import { FocusId } from '../../store/types.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

/**
 * 问题选项类型
 */
interface QuestionOption {
  label: string;
  description: string;
}

/**
 * 问题类型
 */
interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * QuestionPrompt Props
 */
interface QuestionPromptProps {
  questions: Question[];
  onComplete: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

/**
 * 单个选项组件
 */
const OptionItem = React.memo<{
  option: { label: string; description: string; value: string };
  index: number;
  isSelected: boolean;
  isMultiSelect: boolean;
  isHighlighted: boolean;
}>(({ option, index, isSelected, isMultiSelect, isHighlighted }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text
      color={isHighlighted ? 'yellow' : isSelected ? 'green' : undefined}
      bold={isHighlighted}
    >
      {isMultiSelect ? (isSelected ? '● ' : '○ ') : isHighlighted ? '❯ ' : '  '}
      {index + 1}. {option.label}
    </Text>
    <Box marginLeft={4}>
      <Text color="gray">{option.description}</Text>
    </Box>
  </Box>
));

/**
 * 答案摘要组件（用于 Submit 界面）
 */
const AnswerSummary = React.memo<{
  questions: Question[];
  answers: Record<string, string | string[]>;
}>(({ questions, answers }) => (
  <Box flexDirection="column" marginBottom={1}>
    {questions.map((q) => {
      const answer = answers[q.header];
      const answerStr = Array.isArray(answer)
        ? answer.join(', ')
        : answer || '(no answer)';
      return (
        <Box key={q.header} marginBottom={1}>
          <Text backgroundColor="blue" color="white">
            {' '}
            {q.header}{' '}
          </Text>
          <Text color="green"> {answerStr}</Text>
        </Box>
      );
    })}
  </Box>
));

/**
 * 阶段类型
 */
type Phase = 'answering' | 'submit';

/**
 * QuestionPrompt 组件
 * 显示结构化问题并收集用户答案
 */
export const QuestionPrompt: React.FC<QuestionPromptProps> = React.memo(
  ({ questions, onComplete, onCancel }) => {
    const { stdout } = useStdout();
    const terminalWidth = stdout.columns || 80;

    // 焦点管理
    const currentFocus = useCurrentFocus();
    const isFocused = currentFocus === FocusId.CONFIRMATION_PROMPT;

    // Ctrl+C 处理
    const handleCtrlC = useCtrlCHandler(false);

    // 状态
    const [phase, setPhase] = useState<Phase>('answering');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
    const [isCustomMode, setIsCustomMode] = useState(false);
    const [customInput, setCustomInput] = useState('');
    const [submitHighlight, setSubmitHighlight] = useState(0); // 0: Submit, 1: Edit

    const current = questions[currentIndex];

    // 选项列表：添加 "Other" 选项
    const options = useMemo(() => {
      if (!current) return [];
      return [
        ...current.options.map((opt) => ({
          label: opt.label,
          value: opt.label,
          description: opt.description,
        })),
        {
          label: 'Type something...',
          value: '__other__',
          description: 'Enter custom response',
        },
      ];
    }, [current]);

    // 提交答案并进入下一题或 Submit 界面
    const submitAnswer = useCallback(
      (answer: string | string[]) => {
        const newAnswers = { ...answers, [current.header]: answer };
        setAnswers(newAnswers);

        if (currentIndex < questions.length - 1) {
          // 还有更多问题
          setCurrentIndex(currentIndex + 1);
          setHighlightedIndex(0);
          setSelectedMulti([]);
          setIsCustomMode(false);
          setCustomInput('');
        } else {
          // 所有问题已回答，进入 Submit 界面
          setPhase('submit');
          setSubmitHighlight(0);
        }
      },
      [answers, current?.header, currentIndex, questions.length]
    );

    // 处理选择
    const handleSelect = useCallback(
      (index: number) => {
        const selected = options[index];
        if (!selected) return;

        if (selected.value === '__other__') {
          setIsCustomMode(true);
          return;
        }

        if (current.multiSelect) {
          // 多选模式：切换选中状态
          setSelectedMulti((prev) =>
            prev.includes(selected.value)
              ? prev.filter((v) => v !== selected.value)
              : [...prev, selected.value]
          );
        } else {
          // 单选模式：直接提交
          submitAnswer(selected.value);
        }
      },
      [options, current?.multiSelect, submitAnswer]
    );

    // 处理自定义输入提交
    const handleCustomSubmit = useCallback(
      (text: string) => {
        if (text.trim()) {
          submitAnswer(text.trim());
        }
      },
      [submitAnswer]
    );

    // 返回编辑答案
    const goBackToEdit = useCallback(() => {
      setPhase('answering');
      setCurrentIndex(0);
      setHighlightedIndex(0);
      setSelectedMulti([]);
      setIsCustomMode(false);
    }, []);

    // 最终提交
    const handleFinalSubmit = useCallback(() => {
      onComplete(answers);
    }, [answers, onComplete]);

    // 键盘输入处理 - 回答阶段
    useInput(
      (input, key) => {
        // Ctrl+C: 退出
        if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
          handleCtrlC();
          return;
        }

        // 自定义输入模式
        if (isCustomMode) {
          if (key.escape) {
            setIsCustomMode(false);
            setCustomInput('');
          }
          return; // TextInput 会处理其他输入
        }

        // Esc: 取消
        if (key.escape) {
          onCancel();
          return;
        }

        // 数字键快捷选择 (1-9)
        const num = parseInt(input);
        if (num >= 1 && num <= options.length) {
          handleSelect(num - 1);
          return;
        }

        // 上下导航
        if (key.upArrow) {
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
          return;
        }
        if (key.downArrow || key.tab) {
          setHighlightedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
          return;
        }

        // Enter: 确认选择
        if (key.return) {
          if (current.multiSelect && selectedMulti.length > 0) {
            submitAnswer(selectedMulti);
          } else {
            handleSelect(highlightedIndex);
          }
          return;
        }

        // Space: 多选模式切换
        if (input === ' ' && current.multiSelect) {
          const selected = options[highlightedIndex];
          if (selected && selected.value !== '__other__') {
            setSelectedMulti((prev) =>
              prev.includes(selected.value)
                ? prev.filter((v) => v !== selected.value)
                : [...prev, selected.value]
            );
          }
          return;
        }
      },
      { isActive: isFocused && phase === 'answering' && !isCustomMode }
    );

    // 键盘输入处理 - Submit 阶段
    useInput(
      (input, key) => {
        // Ctrl+C: 退出
        if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
          handleCtrlC();
          return;
        }

        // Esc: 取消
        if (key.escape) {
          onCancel();
          return;
        }

        // 上下导航
        if (key.upArrow || key.downArrow || key.tab) {
          setSubmitHighlight((prev) => (prev === 0 ? 1 : 0));
          return;
        }

        // Enter: 确认
        if (key.return) {
          if (submitHighlight === 0) {
            handleFinalSubmit();
          } else {
            goBackToEdit();
          }
          return;
        }

        // Y: 快捷提交
        if (input.toLowerCase() === 'y') {
          handleFinalSubmit();
          return;
        }

        // E: 快捷编辑
        if (input.toLowerCase() === 'e') {
          goBackToEdit();
          return;
        }
      },
      { isActive: isFocused && phase === 'submit' }
    );

    // Submit 界面渲染
    if (phase === 'submit') {
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={isFocused ? 'green' : 'gray'}
          padding={1}
          width={Math.min(terminalWidth - 4, 80)}
        >
          {/* 标题 */}
          <Box marginBottom={1}>
            <Text bold color="green">
              ✓ Review Your Answers
            </Text>
          </Box>

          {/* 答案摘要 */}
          <AnswerSummary questions={questions} answers={answers} />

          {/* 操作选项 */}
          <Box flexDirection="column" marginTop={1}>
            <Text
              color={submitHighlight === 0 ? 'yellow' : undefined}
              bold={submitHighlight === 0}
            >
              {submitHighlight === 0 ? '❯ ' : '  '}
              [Y] Submit answers
            </Text>
            <Text
              color={submitHighlight === 1 ? 'yellow' : undefined}
              bold={submitHighlight === 1}
            >
              {submitHighlight === 1 ? '❯ ' : '  '}
              [E] Edit answers
            </Text>
          </Box>

          {/* 导航提示 */}
          <Box marginTop={1}>
            <Text color="gray">
              Enter to confirm · ↑↓ to navigate · Y/E for quick select
            </Text>
          </Box>
        </Box>
      );
    }

    // 回答阶段渲染
    if (!current) {
      return null;
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isFocused ? 'cyan' : 'gray'}
        padding={1}
        width={Math.min(terminalWidth - 4, 80)}
      >
        {/* 头部：芯片标签 + 问题 */}
        <Box marginBottom={1}>
          <Text backgroundColor="blue" color="white">
            {' '}
            {current.header}{' '}
          </Text>
          <Text> {current.question}</Text>
        </Box>

        {/* 选项列表或自定义输入 */}
        {isCustomMode ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">Enter your response:</Text>
            <Box marginTop={1}>
              <Text color="cyan">{'❯ '}</Text>
              <TextInput
                value={customInput}
                onChange={setCustomInput}
                onSubmit={handleCustomSubmit}
                focus={isFocused}
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">(Press Enter to submit, ESC to go back)</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {options.map((opt, idx) => (
              <OptionItem
                key={opt.value}
                option={opt}
                index={idx}
                isSelected={selectedMulti.includes(opt.value)}
                isMultiSelect={current.multiSelect}
                isHighlighted={highlightedIndex === idx}
              />
            ))}
          </Box>
        )}

        {/* 导航提示 */}
        {!isCustomMode && (
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              {current.multiSelect
                ? 'Space to toggle · Enter to confirm · 1-9 for quick select'
                : 'Enter to select · ↑↓ or Tab to navigate · 1-9 for quick select'}
            </Text>
            {current.multiSelect && selectedMulti.length > 0 && (
              <Text color="green">Selected: {selectedMulti.join(', ')}</Text>
            )}
          </Box>
        )}

        {/* 进度指示 */}
        {questions.length > 1 && (
          <Box marginTop={1}>
            <Text color="gray">
              Question {currentIndex + 1} of {questions.length}
            </Text>
          </Box>
        )}
      </Box>
    );
  }
);
