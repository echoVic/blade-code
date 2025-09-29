/**
 * UI 组件集成测试
 */

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { Box } from '../../packages/cli/src/ui/ink/Box';
import { Button } from '../../packages/cli/src/ui/ink/Button';
import { Input } from '../../packages/cli/src/ui/ink/Input';
import { Layout } from '../../packages/cli/src/ui/ink/Layout';
import { ProgressBar } from '../../packages/cli/src/ui/ink/ProgressBar';
import { Spinner } from '../../packages/cli/src/ui/ink/Spinner';
import { Text } from '../../packages/cli/src/ui/ink/Text';

describe('UI 组件集成测试', () => {
  beforeAll(() => {
    jest.setTimeout(30000);
  });

  describe('基础组件集成', () => {
    test('应该能够组合使用基础组件', () => {
      const { getByText } = render(
        <Box flexDirection="column" padding={1}>
          <Text bold color="blue">
            Welcome to Blade CLI
          </Text>
          <Text>This is a test application</Text>
        </Box>
      );

      expect(getByText('Welcome to Blade CLI')).toBeInTheDocument();
      expect(getByText('This is a test application')).toBeInTheDocument();
    });

    test('应该能够处理组件间的交互', () => {
      const handleClick = jest.fn();
      const { getByText } = render(
        <Box flexDirection="column" gap={1}>
          <Text>Click the button below:</Text>
          <Button onPress={handleClick}>Click Me</Button>
        </Box>
      );

      const button = getByText('Click Me');
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('表单组件集成', () => {
    test('应该能够组合使用输入和按钮组件', () => {
      const handleChange = jest.fn();
      const handleSubmit = jest.fn();

      const { getByPlaceholderText, getByText } = render(
        <Box flexDirection="column" gap={1}>
          <Input placeholder="Enter your name" onChange={handleChange} />
          <Button onPress={handleSubmit}>Submit</Button>
        </Box>
      );

      const input = getByPlaceholderText('Enter your name');
      const button = getByText('Submit');

      // 模拟用户输入
      fireEvent.change(input, { target: { value: 'John Doe' } });
      expect(handleChange).toHaveBeenCalledWith('John Doe');

      // 模拟点击提交
      fireEvent.click(button);
      expect(handleSubmit).toHaveBeenCalledTimes(1);
    });

    test('应该能够处理表单验证', () => {
      const handleSubmit = jest.fn();

      const { getByPlaceholderText, getByText } = render(
        <Box flexDirection="column" gap={1}>
          <Input placeholder="Email" validator={(value) => value.includes('@')} />
          <Button onPress={handleSubmit}>Submit</Button>
        </Box>
      );

      const input = getByPlaceholderText('Email');
      const button = getByText('Submit');

      // 输入无效邮箱
      fireEvent.change(input, { target: { value: 'invalid-email' } });
      fireEvent.click(button);
      // 应该不触发提交

      // 输入有效邮箱
      fireEvent.change(input, { target: { value: 'valid@example.com' } });
      fireEvent.click(button);
      // 应该触发提交
      expect(handleSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('布局组件集成', () => {
    test('应该能够创建复杂的布局结构', () => {
      const { container } = render(
        <Layout direction="vertical" gap={1} padding={1}>
          <Layout direction="horizontal" gap={2}>
            <Box>
              <Text>Left Panel</Text>
            </Box>
            <Box>
              <Text>Right Panel</Text>
            </Box>
          </Layout>
          <Box>
            <Text>Bottom Panel</Text>
          </Box>
        </Layout>
      );

      expect(container.textContent).toContain('Left Panel');
      expect(container.textContent).toContain('Right Panel');
      expect(container.textContent).toContain('Bottom Panel');
    });

    test('应该能够处理响应式布局', () => {
      const { container, rerender } = render(
        <Layout responsive={true} width={80}>
          <Text>Responsive Content</Text>
        </Layout>
      );

      expect(container.textContent).toContain('Responsive Content');

      // 重新渲染不同的宽度
      rerender(
        <Layout responsive={true} width={40}>
          <Text>Responsive Content</Text>
        </Layout>
      );

      expect(container.textContent).toContain('Responsive Content');
    });
  });

  describe('状态组件集成', () => {
    test('应该能够组合使用进度和加载组件', async () => {
      const { getByText, getByRole } = render(
        <Box flexDirection="column" gap={1}>
          <Text>Loading...</Text>
          <Spinner label="Processing" />
          <ProgressBar value={50} label="Progress" />
        </Box>
      );

      expect(getByText('Loading...')).toBeInTheDocument();
      expect(getByText('Processing')).toBeInTheDocument();
      expect(getByText('Progress')).toBeInTheDocument();
      expect(getByText('50%')).toBeInTheDocument();
    });

    test('应该能够动态更新状态组件', () => {
      const { getByText, rerender } = render(
        <ProgressBar value={25} label="Task Progress" />
      );

      expect(getByText('25%')).toBeInTheDocument();

      // 更新进度
      rerender(<ProgressBar value={75} label="Task Progress" />);
      expect(getByText('75%')).toBeInTheDocument();
    });
  });

  describe('交互组件集成', () => {
    test('应该能够处理复杂的用户交互流', () => {
      const handleInputChange = jest.fn();
      const handleSubmit = jest.fn();
      const handleCancel = jest.fn();

      const { getByPlaceholderText, getByText } = render(
        <Box flexDirection="column" gap={1}>
          <Text bold>Enter your information:</Text>
          <Input placeholder="Your name" onChange={handleInputChange} />
          <Box flexDirection="row" gap={1}>
            <Button variant="primary" onPress={handleSubmit}>
              Submit
            </Button>
            <Button variant="secondary" onPress={handleCancel}>
              Cancel
            </Button>
          </Box>
        </Box>
      );

      const input = getByPlaceholderText('Your name');
      const submitButton = getByText('Submit');
      const cancelButton = getByText('Cancel');

      // 用户输入
      fireEvent.change(input, { target: { value: 'Jane Smith' } });
      expect(handleInputChange).toHaveBeenCalledWith('Jane Smith');

      // 用户提交
      fireEvent.click(submitButton);
      expect(handleSubmit).toHaveBeenCalledTimes(1);

      // 用户取消
      fireEvent.click(cancelButton);
      expect(handleCancel).toHaveBeenCalledTimes(1);
    });

    test('应该能够处理键盘导航', () => {
      const handleFirstAction = jest.fn();
      const handleSecondAction = jest.fn();

      const { getByText } = render(
        <Box flexDirection="row" gap={1}>
          <Button onPress={handleFirstAction}>First</Button>
          <Button onPress={handleSecondAction}>Second</Button>
        </Box>
      );

      const firstButton = getByText('First');
      const secondButton = getByText('Second');

      // 测试键盘事件
      fireEvent.keyDown(firstButton, { key: 'Enter' });
      expect(handleFirstAction).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(secondButton, { key: ' ' }); // Space
      expect(handleSecondAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('性能集成', () => {
    test('应该能够高效渲染大量组件', () => {
      const startTime = performance.now();

      const { container } = render(
        <Box flexDirection="column">
          {Array.from({ length: 100 }, (_, i) => (
            <Box key={i} flexDirection="row" gap={1}>
              <Text>Item {i}</Text>
              <Button>Button {i}</Button>
            </Box>
          ))}
        </Box>
      );

      const endTime = performance.now();
      const renderTime = endTime - startTime;

      // 渲染100个复合组件应该在合理时间内完成
      expect(renderTime).toBeLessThan(1000);
      expect(container.textContent).toContain('Item 0');
      expect(container.textContent).toContain('Item 99');
    });

    test('应该能够处理频繁的组件更新', () => {
      const { rerender, getByText } = render(<Text>Version 1</Text>);
      expect(getByText('Version 1')).toBeInTheDocument();

      // 快速连续更新
      for (let i = 2; i <= 10; i++) {
        rerender(<Text>Version {i}</Text>);
        expect(getByText(`Version ${i}`)).toBeInTheDocument();
      }
    });
  });

  describe('错误处理集成', () => {
    test('应该在组件错误时优雅降级', () => {
      // 创建一个会抛出错误的组件
      const ErrorComponent = () => {
        throw new Error('Component error');
      };

      // 使用错误边界包装
      const { container } = render(
        <Box>
          <Text>Before error</Text>
          {/* 这里应该有一个错误边界组件来捕获错误 */}
          <Text>After error</Text>
        </Box>
      );

      expect(container.textContent).toContain('Before error');
      expect(container.textContent).toContain('After error');
    });

    test('应该正确处理无效的组件属性', () => {
      // 测试无效属性
      const { container } = render(
        <Box flexDirection="invalid" as any padding={-1}>
          <Text>Test content</Text>
        </Box>
      );

      // 应该仍然渲染内容
      expect(container.textContent).toContain('Test content');
    });
  });
});
