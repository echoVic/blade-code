import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'fs';
import inquirer from 'inquirer';
import path from 'path';

/**
 * 注册初始化命令
 */
export function initCommand(program: Command) {
  program
    .command('init')
    .description('初始化一个新项目')
    .argument('[name]', '项目名称')
    .option('-t, --template <template>', '使用的模板', 'default')
    .action(async (name, options) => {
      console.log(chalk.blue('🚀 开始初始化项目...'));
      
      // 如果没有提供名称，通过交互式提示获取
      if (!name) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'projectName',
            message: '请输入项目名称:',
            default: 'my-project'
          }
        ]);
        name = answers.projectName;
      }
      
      // 获取模板选择
      if (options.template === 'default') {
        const answers = await inquirer.prompt([
          {
            type: 'list',
            name: 'template',
            message: '请选择项目模板:',
            choices: ['react', 'vue', 'node']
          }
        ]);
        options.template = answers.template;
      }
      
      // 创建项目目录
      const projectPath = path.resolve(process.cwd(), name);
      
      // 检查目录是否已存在
      if (fs.existsSync(projectPath)) {
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `目录 ${name} 已存在，是否覆盖?`,
            default: false
          }
        ]);
        
        if (!overwrite) {
          console.log(chalk.yellow('❌ 操作已取消'));
          return;
        }
        
        // 删除目录
        fs.rmSync(projectPath, { recursive: true, force: true });
      }
      
      // 创建目录
      fs.mkdirSync(projectPath, { recursive: true });
      
      // 这里可以添加根据模板创建项目的逻辑
      // 示例: 创建简单的 package.json
      const packageJson = {
        name,
        version: '0.1.0',
        description: `${name} project created by agent-cli`,
        type: 'module',
        main: 'index.js',
        scripts: {
          start: 'node index.js'
        },
        keywords: [],
        author: '',
        license: 'MIT'
      };
      
      fs.writeFileSync(
        path.join(projectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );
      
      // 创建示例文件
      fs.writeFileSync(
        path.join(projectPath, 'index.js'),
        `console.log('Hello from ${name}!');\n`
      );
      
      console.log(chalk.green(`✅ 项目 ${name} 已成功创建!`));
      console.log(chalk.cyan(`模板: ${options.template}`));
      console.log(chalk.cyan(`位置: ${projectPath}`));
      console.log('');
      console.log(chalk.yellow('接下来:'));
      console.log(`  cd ${name}`);
      console.log('  npm install');
      console.log('  npm start');
    });
} 