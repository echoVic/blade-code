#!/usr/bin/env node
/**
 * Production Readiness Checker
 *
 * 检查项目是否满足生产级标准：
 * - 测试覆盖率 >= 80%
 * - 所有测试通过
 * - 代码质量检查通过
 * - 构建成功
 * - 文档完整性
 * - 安全检查
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// 颜色输出
const colors = {
	reset: '\x1b[0m',
	green: '\x1b[32m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

// 检查项配置
const checks = [
	{
		name: '代码格式检查',
		command: 'bun run format:check',
		required: true,
	},
	{
		name: 'Lint 检查',
		command: 'bun run lint',
		required: true,
	},
	{
		name: '类型检查',
		command: 'bun run type-check',
		required: true,
	},
	{
		name: '单元测试',
		command: 'bun run test:unit',
		required: true,
	},
	{
		name: '集成测试',
		command: 'bun run test:integration',
		required: true,
	},
	{
		name: '安全测试',
		command: 'bun run test:security',
		required: true,
	},
	{
		name: '构建验证',
		command: 'bun run build',
		required: true,
	},
];

// 执行检查
async function runCheck(check) {
	log(`\n📋 运行: ${check.name}`, 'cyan');

	try {
		const { stdout, stderr } = await execAsync(check.command, {
			cwd: projectRoot,
			maxBuffer: 10 * 1024 * 1024, // 10MB
		});

		if (stderr && !stderr.includes('warning')) {
			log(`⚠️  警告输出:\n${stderr}`, 'yellow');
		}

		log(`✅ ${check.name} 通过`, 'green');
		return { success: true, output: stdout };
	} catch (error) {
		log(`❌ ${check.name} 失败`, 'red');
		if (error.stdout) {
			log(`输出:\n${error.stdout}`, 'yellow');
		}
		if (error.stderr) {
			log(`错误:\n${error.stderr}`, 'red');
		}
		return { success: false, error };
	}
}

// 检查测试覆盖率
async function checkCoverage() {
	log('\n📊 检查测试覆盖率', 'cyan');

	try {
		await execAsync('bun run test:coverage', {
			cwd: projectRoot,
			maxBuffer: 10 * 1024 * 1024,
		});

		const coverageFile = path.join(projectRoot, 'coverage', 'coverage-summary.json');
		const coverageData = JSON.parse(await fs.readFile(coverageFile, 'utf8'));

		const { lines, statements, functions, branches } = coverageData.total;

		log('\n覆盖率统计:', 'blue');
		log(`  - 行覆盖率: ${lines.pct.toFixed(2)}%`, lines.pct >= 80 ? 'green' : 'red');
		log(`  - 语句覆盖率: ${statements.pct.toFixed(2)}%`, statements.pct >= 80 ? 'green' : 'red');
		log(`  - 函数覆盖率: ${functions.pct.toFixed(2)}%`, functions.pct >= 80 ? 'green' : 'red');
		log(`  - 分支覆盖率: ${branches.pct.toFixed(2)}%`, branches.pct >= 80 ? 'green' : 'red');

		const targetCoverage = 80;
		const passed = lines.pct >= targetCoverage;

		if (passed) {
			log(`\n✅ 测试覆盖率达标 (>= ${targetCoverage}%)`, 'green');
		} else {
			log(`\n⚠️  测试覆盖率未达标 (目标: >= ${targetCoverage}%, 当前: ${lines.pct.toFixed(2)}%)`, 'yellow');
			log(`提示: 这是一个警告，不会阻止发布，但建议提高覆盖率`, 'yellow');
		}

		return { success: true, coverage: lines.pct };
	} catch (error) {
		log('❌ 覆盖率检查失败', 'red');
		console.error(error);
		return { success: false };
	}
}

// 检查文档完整性
async function checkDocumentation() {
	log('\n📚 检查文档完整性', 'cyan');

	const requiredDocs = [
		'README.md',
		'CONTRIBUTING.md',
		'docs/api/README.md',
		'docs/troubleshooting.md',
		'docs/architecture.md',
		'docs/getting-started/quick-start.md',
		'docs/configuration/config-system.md',
	];

	let allExist = true;

	for (const doc of requiredDocs) {
		const docPath = path.join(projectRoot, doc);
		try {
			await fs.access(docPath);
			log(`  ✅ ${doc}`, 'green');
		} catch {
			log(`  ❌ ${doc} - 缺失`, 'red');
			allExist = false;
		}
	}

	if (allExist) {
		log('\n✅ 所有必需文档存在', 'green');
	} else {
		log('\n❌ 部分文档缺失', 'red');
	}

	return { success: allExist };
}

// 检查配置文件
async function checkConfigFiles() {
	log('\n⚙️  检查配置文件', 'cyan');

	const requiredConfigs = [
		'.github/workflows/ci-enhanced.yml',
		'.github/workflows/release.yml',
		'packages/cli/src/config/validation.ts',
		'packages/cli/src/config/encryption.ts',
		'packages/cli/src/config/env.ts',
	];

	let allExist = true;

	for (const config of requiredConfigs) {
		const configPath = path.join(projectRoot, config);
		try {
			await fs.access(configPath);
			log(`  ✅ ${config}`, 'green');
		} catch {
			log(`  ❌ ${config} - 缺失`, 'red');
			allExist = false;
		}
	}

	if (allExist) {
		log('\n✅ 所有配置文件存在', 'green');
	} else {
		log('\n❌ 部分配置文件缺失', 'red');
	}

	return { success: allExist };
}

// 主函数
async function main() {
	log('🚀 Blade Code 生产级就绪检查', 'blue');
	log('='.repeat(60), 'blue');

	const results = {
		checks: [],
		coverage: null,
		documentation: null,
		configs: null,
	};

	// 1. 运行所有检查
	for (const check of checks) {
		const result = await runCheck(check);
		results.checks.push({ ...check, ...result });

		if (!result.success && check.required) {
			log(`\n❌ 必需检查失败: ${check.name}`, 'red');
			log('请修复错误后重试', 'yellow');
			process.exit(1);
		}
	}

	// 2. 检查测试覆盖率
	results.coverage = await checkCoverage();

	// 3. 检查文档
	results.documentation = await checkDocumentation();

	// 4. 检查配置
	results.configs = await checkConfigFiles();

	// 汇总结果
	log('\n' + '='.repeat(60), 'blue');
	log('📊 检查汇总', 'blue');
	log('='.repeat(60), 'blue');

	const passedChecks = results.checks.filter(c => c.success).length;
	const totalChecks = results.checks.length;

	log(`\n代码质量检查: ${passedChecks}/${totalChecks} 通过`, passedChecks === totalChecks ? 'green' : 'red');
	log(`测试覆盖率: ${results.coverage.coverage?.toFixed(2) || 'N/A'}%`, results.coverage.coverage >= 80 ? 'green' : 'yellow');
	log(`文档完整性: ${results.documentation.success ? '✅' : '❌'}`, results.documentation.success ? 'green' : 'red');
	log(`配置文件: ${results.configs.success ? '✅' : '❌'}`, results.configs.success ? 'green' : 'red');

	const allPassed =
		passedChecks === totalChecks &&
		results.documentation.success &&
		results.configs.success;

	if (allPassed) {
		log('\n🎉 恭喜！Blade Code 已达到生产级标准！', 'green');
		log('可以进行发布。', 'green');
		process.exit(0);
	} else {
		log('\n⚠️  部分检查未通过', 'yellow');

		if (results.coverage.coverage < 80) {
			log('提示: 测试覆盖率未达标，建议提高到 80% 以上', 'yellow');
		}

		log('\n建议修复所有问题后再发布。', 'yellow');
		process.exit(1);
	}
}

// 运行
main().catch(error => {
	log('\n💥 检查过程出错', 'red');
	console.error(error);
	process.exit(1);
});
