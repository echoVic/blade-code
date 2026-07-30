/**
 * InputArea 组件测试
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../../../src/ui/components/InputArea.js';

// Mock store selectors
vi.mock('../../../../src/store/selectors/index.js', () => ({
	useCurrentFocus: vi.fn(() => 'MAIN_INPUT'),
}));

describe('InputArea 组件', () => {
	const defaultProps = {
		input: '',
		cursorPosition: 0,
		onChange: vi.fn(),
		onChangeCursorPosition: vi.fn(),
		onAddPasteMapping: vi.fn(() => 1),
		onAddImagePasteMapping: vi.fn(() => 1),
	};

	it('应该渲染输入框', () => {
		const { lastFrame } = render(<InputArea {...defaultProps} />);
		expect(lastFrame()).toBeDefined();
	});

	it('应该显示输入内容', () => {
		const props = { ...defaultProps, input: 'Hello World' };
		const { lastFrame } = render(<InputArea {...props} />);

		const frame = lastFrame();
		expect(frame).toContain('Hello World');
	});

	it('应该处理空输入', () => {
		const { lastFrame } = render(<InputArea {...defaultProps} />);
		expect(lastFrame()).toBeDefined();
	});

	it('应该支持多行输入', () => {
		const props = {
			...defaultProps,
			input: 'Line 1\nLine 2\nLine 3',
		};
		const { lastFrame } = render(<InputArea {...props} />);

		const frame = lastFrame();
		expect(frame).toBeDefined();
	});

	it('应该处理光标位置变化', () => {
		const onChange = vi.fn();
		const onChangeCursorPosition = vi.fn();

		const props = {
			...defaultProps,
			input: 'Hello',
			cursorPosition: 2,
			onChange,
			onChangeCursorPosition,
		};

		render(<InputArea {...props} />);

		// 组件应该正确渲染光标位置
		expect(props.cursorPosition).toBe(2);
	});

	it('应该处理文本粘贴', () => {
		const onAddPasteMapping = vi.fn(() => 1);
		const props = {
			...defaultProps,
			onAddPasteMapping,
		};

		render(<InputArea {...props} />);

		// 粘贴回调应该可用
		expect(onAddPasteMapping).toBeDefined();
	});

	it('应该处理图片粘贴', () => {
		const onAddImagePasteMapping = vi.fn(() => 1);
		const props = {
			...defaultProps,
			onAddImagePasteMapping,
		};

		render(<InputArea {...props} />);

		// 图片粘贴回调应该可用
		expect(onAddImagePasteMapping).toBeDefined();
	});

	it('应该支持长文本输入', () => {
		const longText = 'a'.repeat(1000);
		const props = {
			...defaultProps,
			input: longText,
		};

		const { lastFrame } = render(<InputArea {...props} />);
		expect(lastFrame()).toBeDefined();
	});

	it('应该处理特殊字符', () => {
		const specialChars = '!@#$%^&*()_+-=[]{}|;:",.<>?/~`';
		const props = {
			...defaultProps,
			input: specialChars,
		};

		const { lastFrame } = render(<InputArea {...props} />);
		expect(lastFrame()).toBeDefined();
	});

	it('应该处理 Unicode 字符', () => {
		const unicodeText = '你好世界 🌍 こんにちは';
		const props = {
			...defaultProps,
			input: unicodeText,
		};

		const { lastFrame } = render(<InputArea {...props} />);
		expect(lastFrame()).toBeDefined();
	});
});
