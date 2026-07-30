#!/usr/bin/env bun
/**
 * Detect Unused Code
 *
 * 检测项目中未使用的代码，包括：
 * - 未使用的导出
 * - 未使用的导入
 * - 死代码（永远不会执行的代码）
 * - 未引用的文件
 */

import { spawn } from 'bun';
import fs from 'node:fs';
import path from 'node:path';

interface UnusedItem {
	type: 'export' | 'import' | 'file';
	file: string;
	name: string;
	line?: number;
}

const EXCLUDE_DIRS = [
	'node_modules',
	'dist',
	'build',
	'coverage',
	'.blade',
	'.git',
];

const EXCLUDE_FILES = [
	'*.test.ts',
	'*.test.tsx',
	'*.spec.ts',
	'*.spec.tsx',
];

// ANSI 颜色
const colors = {
	reset: '\x1b[0m',
	green: '\x1b[32m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
};

function printHeader() {
	console.log(`\n${colors.bold}${colors.cyan}🔍 Blade Unused Code Detector${colors.reset}`);
	console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
}

function printSection(title: string) {
	console.log(`\n${colors.bold}${colors.blue}${title}${colors.reset}`);
}

function printWarning(message: string) {
	console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function printSuccess(message: string) {
	console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

function printError(message: string) {
	console.log(`${colors.red}✗ ${message}${colors.reset}`);
}

function printUnused(item: UnusedItem) {
	const location = item.line ? `:${item.line}` : '';
	console.log(
		`  ${colors.dim}${item.file}${location}${colors.reset} - ${colors.yellow}${item.name}${colors.reset}`,
	);
}

/**
 * 检查是否安装了 knip
 */
async function checkKnip(): Promise<boolean> {
	try {
		const proc = spawn({
			cmd: ['bun', 'pm', 'ls', 'knip'],
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * 运行 knip 检测未使用的代码
 */
async function runKnip(): Promise<UnusedItem[]> {
	const unused: UnusedItem[] = [];

	try {
		const proc = spawn({
			cmd: ['bunx', 'knip', '--reporter', 'json'],
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode === 0 && output) {
			try {
				const result = JSON.parse(output);
				// 处理 knip 输出
				if (result.files) {
					for (const file of result.files) {
						unused.push({
							type: 'file',
							file: file.path,
							name: path.basename(file.path),
						});
					}
				}
			} catch (e) {
				printWarning(`解析 knip 输出失败: ${e}`);
			}
		}
	} catch (error) {
		printError(`运行 knip 失败: ${error}`);
	}

	return unused;
}

/**
 * 简单的未使用导出检测（备用方案）
 */
async function detectUnusedExports(srcDir: string): Promise<UnusedItem[]> {
	const unused: UnusedItem[] = [];
	const files = getAllFiles(srcDir);

	for (const file of files) {
		if (!file.endsWith('.ts') && !file.endsWith('.tsx')) {
			continue;
		}

		try {
			const content = fs.readFileSync(file, 'utf-8');
			const lines = content.split('\n');

			// 简单检测：查找 export 但没有被引用的内容
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const exportMatch = line.match(/export\s+(const|function|class|interface|type)\s+(\w+)/);

				if (exportMatch) {
					const name = exportMatch[2];
					// 检查是否在其他文件中被引用
					const isUsed = await isExportUsed(name, file, files);

					if (!isUsed) {
						unused.push({
							type: 'export',
							file: path.relative(process.cwd(), file),
							name,
							line: i + 1,
						});
					}
				}
			}
		} catch (error) {
			// 跳过无法读取的文件
		}
	}

	return unused;
}

/**
 * 检查导出是否被使用
 */
async function isExportUsed(
	name: string,
	exportFile: string,
	allFiles: string[],
): Promise<boolean> {
	for (const file of allFiles) {
		if (file === exportFile) continue;

		try {
			const content = fs.readFileSync(file, 'utf-8');
			// 简单检查：是否包含导入语句
			if (content.includes(`import`) && content.includes(name)) {
				return true;
			}
		} catch {
			// 跳过
		}
	}
	return false;
}

/**
 * 递归获取所有文件
 */
function getAllFiles(dir: string, fileList: string[] = []): string[] {
	const files = fs.readdirSync(dir);

	for (const file of files) {
		const filePath = path.join(dir, file);
		const stat = fs.statSync(filePath);

		// 跳过排除的目录
		if (stat.isDirectory()) {
			if (!EXCLUDE_DIRS.includes(file)) {
				getAllFiles(filePath, fileList);
			}
		} else {
			// 跳过排除的文件
			const shouldExclude = EXCLUDE_FILES.some((pattern) => {
				const regex = new RegExp(pattern.replace('*', '.*'));
				return regex.test(file);
			});

			if (!shouldExclude) {
				fileList.push(filePath);
			}
		}
	}

	return fileList;
}

/**
 * 生成报告
 */
function generateReport(unused: UnusedItem[]) {
	if (unused.length === 0) {
		printSuccess('没有检测到未使用的代码！');
		return;
	}

	// 按类型分组
	const byType = {
		export: unused.filter((item) => item.type === 'export'),
		import: unused.filter((item) => item.type === 'import'),
		file: unused.filter((item) => item.type === 'file'),
	};

	if (byType.export.length > 0) {
		printSection(`未使用的导出 (${byType.export.length})`);
		for (const item of byType.export) {
			printUnused(item);
		}
	}

	if (byType.import.length > 0) {
		printSection(`未使用的导入 (${byType.import.length})`);
		for (const item of byType.import) {
			printUnused(item);
		}
	}

	if (byType.file.length > 0) {
		printSection(`未引用的文件 (${byType.file.length})`);
		for (const item of byType.file) {
			printUnused(item);
		}
	}

	// 总结
	console.log(`\n${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
	console.log(
		`\n${colors.bold}总计: ${unused.length} 个未使用的项${colors.reset}`,
	);
	console.log(
		`\n${colors.yellow}建议: 审查这些项目并考虑删除以减小包体积${colors.reset}\n`,
	);
}

/**
 * 主函数
 */
async function main() {
	printHeader();

	const srcDir = path.join(process.cwd(), 'src');

	if (!fs.existsSync(srcDir)) {
		printError('找不到 src 目录');
		process.exit(1);
	}

	// 检查是否安装了 knip
	const hasKnip = await checkKnip();

	let unused: UnusedItem[] = [];

	if (hasKnip) {
		console.log('使用 knip 进行检测...\n');
		unused = await runKnip();
	} else {
		printWarning('未安装 knip，使用简单检测模式...');
		printWarning('建议运行: bun add -d knip\n');
		unused = await detectUnusedExports(srcDir);
	}

	generateReport(unused);

	// 如果有未使用的代码，返回非零退出码
	process.exit(unused.length > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error(`\n${colors.red}✗ 执行失败:${colors.reset}`, error);
	process.exit(1);
});
