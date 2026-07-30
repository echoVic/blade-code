#!/usr/bin/env bun
/**
 * Ready - 发布前的全面质量检查
 *
 * 执行完整的 CI 流程：
 * 1. TypeScript 类型检查
 * 2. 代码格式检查
 * 3. Lint 检查
 * 4. 运行所有测试
 * 5. 构建项目
 *
 * 所有检查通过后才能发布
 */

import { spawn } from 'bun';
import { exit } from 'process';

interface CheckResult {
	name: string;
	passed: boolean;
	duration: number;
	error?: string;
}

const CHECKS = [
	{
		name: '类型检查',
		command: 'bun',
		args: ['run', 'type-check'],
		emoji: '🔍',
	},
	{
		name: '格式检查',
		command: 'bun',
		args: ['run', 'format:check'],
		emoji: '✨',
	},
	{
		name: 'Lint 检查',
		command: 'bun',
		args: ['run', 'lint'],
		emoji: '🔧',
	},
	{
		name: '单元测试',
		command: 'bun',
		args: ['run', 'test:unit'],
		emoji: '🧪',
	},
	{
		name: '集成测试',
		command: 'bun',
		args: ['run', 'test:integration'],
		emoji: '🔗',
	},
	{
		name: '构建项目',
		command: 'bun',
		args: ['run', 'build'],
		emoji: '📦',
	},
];

// ANSI 颜色代码
const colors = {
	reset: '\x1b[0m',
	green: '\x1b[32m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
};

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
}

async function runCheck(check: typeof CHECKS[0]): Promise<CheckResult> {
	const startTime = Date.now();

	try {
		const proc = spawn({
			cmd: [check.command, ...check.args],
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const exitCode = await proc.exited;
		const duration = Date.now() - startTime;

		if (exitCode === 0) {
			return {
				name: check.name,
				passed: true,
				duration,
			};
		}

		// 读取错误输出
		const stderr = await new Response(proc.stderr).text();
		return {
			name: check.name,
			passed: false,
			duration,
			error: stderr,
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		return {
			name: check.name,
			passed: false,
			duration,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function printHeader() {
	console.log(`\n${colors.bold}${colors.blue}🚀 Blade Ready Check${colors.reset}`);
	console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
}

function printCheckStart(check: typeof CHECKS[0]) {
	process.stdout.write(`${check.emoji}  ${check.name}... `);
}

function printCheckResult(result: CheckResult) {
	if (result.passed) {
		console.log(
			`${colors.green}✓${colors.reset} ${colors.dim}(${formatDuration(result.duration)})${colors.reset}`
		);
	} else {
		console.log(
			`${colors.red}✗${colors.reset} ${colors.dim}(${formatDuration(result.duration)})${colors.reset}`
		);
		if (result.error) {
			console.log(`${colors.red}${result.error}${colors.reset}\n`);
		}
	}
}

function printSummary(results: CheckResult[]) {
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;
	const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

	console.log(`\n${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

	if (failed === 0) {
		console.log(
			`\n${colors.bold}${colors.green}✓ 所有检查通过！${colors.reset} ` +
			`${colors.dim}(${passed}/${results.length}, ${formatDuration(totalDuration)})${colors.reset}\n`
		);
		console.log(`${colors.green}🎉 项目已准备好发布！${colors.reset}\n`);
	} else {
		console.log(
			`\n${colors.bold}${colors.red}✗ 检查失败${colors.reset} ` +
			`${colors.dim}(${passed} 通过, ${failed} 失败, ${formatDuration(totalDuration)})${colors.reset}\n`
		);
		console.log(`${colors.yellow}⚠️  请修复以上问题后再尝试发布${colors.reset}\n`);
	}
}

async function main() {
	printHeader();

	const results: CheckResult[] = [];
	let hasFailure = false;

	for (const check of CHECKS) {
		printCheckStart(check);
		const result = await runCheck(check);
		results.push(result);
		printCheckResult(result);

		if (!result.passed) {
			hasFailure = true;
			// 遇到失败就停止后续检查
			console.log(`\n${colors.yellow}⚠️  跳过剩余检查${colors.reset}\n`);
			break;
		}
	}

	printSummary(results);

	exit(hasFailure ? 1 : 0);
}

// 捕获未处理的错误
process.on('unhandledRejection', (error) => {
	console.error(`\n${colors.red}✗ 未处理的错误:${colors.reset}`, error);
	exit(1);
});

main().catch((error) => {
	console.error(`\n${colors.red}✗ 执行失败:${colors.reset}`, error);
	exit(1);
});
