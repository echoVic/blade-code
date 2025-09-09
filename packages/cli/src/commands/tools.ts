import { Command } from 'commander';
import { ToolManager, Tool } from '@blade-ai/core';
import { UIDisplay, UIInput, UILayout, UIList, UIProgress } from '../ui/index.js';

/**
 * 工具相关命令
 */
export function toolsCommand(program: Command): void {
  const toolsCmd = program.command('tools').description('🔧 工具管理和操作');

  // 列出所有工具
  toolsCmd
    .command('list')
    .description('列出所有可用工具')
    .option('-c, --category <category>', '按分类过滤')
    .option('-s, --search <query>', '搜索工具')
    .option('--format <format>', '输出格式', 'table')
    .action(async options => {
      const spinner = UIProgress.spinner('正在加载工具列表...');
      spinner.start();

      try {
        const toolManager = await createToolManager();
        let tools = toolManager.getTools();

        // 分类过滤
        if (options.category) {
          tools = tools.filter(
            tool => tool.category?.toLowerCase() === options.category.toLowerCase()
          );
        }

        // 搜索过滤
        if (options.search) {
          const query = options.search.toLowerCase();
          tools = tools.filter(
            tool =>
              tool.name.toLowerCase().includes(query) ||
              tool.description.toLowerCase().includes(query) ||
              (tool.tags && tool.tags.some(tag => tag.toLowerCase().includes(query)))
          );
        }

        spinner.succeed('工具列表加载完成');

        if (tools.length === 0) {
          UIDisplay.warning('未找到匹配的工具');
          return;
        }

        if (options.format === 'json') {
          console.log(JSON.stringify(tools, null, 2));
        } else {
          displayToolsTable(tools);
        }
      } catch (error: any) {
        spinner.fail('工具列表获取失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });

  // 查看工具详情
  toolsCmd
    .command('info <toolName>')
    .description('查看工具详细信息')
    .action(async toolName => {
      const spinner = UIProgress.spinner(`正在获取工具 "${toolName}" 的信息...`);
      spinner.start();

      try {
        const toolManager = await createToolManager();
        const tool = toolManager.getTool(toolName);

        if (!tool) {
          spinner.fail('工具不存在');
          UIDisplay.error(`工具 "${toolName}" 不存在`);
          return;
        }

        spinner.succeed('工具信息获取完成');
        displayToolInfo(tool);
      } catch (error: any) {
        spinner.fail('工具信息获取失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });

  // 调用工具
  toolsCmd
    .command('call <toolName>')
    .description('调用指定工具')
    .option('-p, --params <params>', '工具参数（JSON格式）', '{}')
    .option('-f, --file <file>', '从文件读取参数')
    .action(async (toolName, options) => {
      let spinner = UIProgress.spinner('正在验证工具...');
      spinner.start();

      try {
        const toolManager = await createToolManager();

        if (!toolManager.hasTool(toolName)) {
          spinner.fail('工具不存在');
          UIDisplay.error(`工具 "${toolName}" 不存在`);
          return;
        }

        spinner.succeed('工具验证完成');

        let params: Record<string, any> = {};

        if (options.file) {
          spinner = UIProgress.spinner('正在读取参数文件...');
          spinner.start();

          const fs = await import('fs/promises');
          const fileContent = await fs.readFile(options.file, 'utf8');
          params = JSON.parse(fileContent);

          spinner.succeed('参数文件读取完成');
        } else {
          params = JSON.parse(options.params);
        }

        UILayout.card(
          '工具调用',
          [`工具名称: ${toolName}`, `参数: ${JSON.stringify(params, null, 2)}`],
          { icon: '🔧' }
        );

        const confirmed = await UIInput.confirm('确认调用该工具？', { default: true });
        if (!confirmed) {
          UIDisplay.info('操作已取消');
          return;
        }

        spinner = UIProgress.spinner('正在调用工具...');
        spinner.start();

        const response = await toolManager.callTool({
          toolName,
          parameters: params,
        });

        spinner.succeed('工具调用完成');
        displayToolResult(response);
      } catch (error: any) {
        if (spinner) spinner.fail('工具调用失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });

  // 生成工具文档
  toolsCmd
    .command('docs')
    .description('生成工具文档')
    .option('-o, --output <file>', '输出文件路径')
    .option('-f, --format <format>', '文档格式', 'markdown')
    .action(async options => {
      const spinner = UIProgress.spinner('正在生成工具文档...');
      spinner.start();

      try {
        const toolManager = await createToolManager();
        const tools = toolManager.getTools();
        const categories = getBuiltinToolsByCategory();

        const docs = generateToolDocs(tools, categories);

        if (options.output) {
          const fs = await import('fs/promises');
          await fs.writeFile(options.output, docs, 'utf8');
          spinner.succeed(`工具文档已保存到: ${options.output}`);
        } else {
          spinner.succeed('工具文档生成完成');
          console.log(docs);
        }
      } catch (error: any) {
        spinner.fail('文档生成失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });

  // 工具统计
  toolsCmd
    .command('stats')
    .description('显示工具统计信息')
    .action(async () => {
      const spinner = UIProgress.spinner('正在收集统计信息...');
      spinner.start();

      try {
        const toolManager = await createToolManager();
        const stats = toolManager.getStats();
        const categories = getBuiltinToolsByCategory();

        spinner.succeed('统计信息收集完成');

        UILayout.card(
          '工具统计信息',
          [
            `总工具数: ${stats.totalTools}`,
            `启用工具: ${stats.enabledTools}`,
            `禁用工具: ${stats.totalTools - stats.enabledTools}`,
            `正在运行: ${stats.runningExecutions}`,
            '',
            '执行统计:',
            `  总执行次数: ${stats.totalExecutions}`,
            `  成功执行: ${stats.successfulExecutions}`,
            `  失败执行: ${stats.failedExecutions}`,
          ],
          { icon: '📊' }
        );

        UIDisplay.section('分类统计');
        const categoryStats = Object.entries(categories).map(
          ([category, tools]) => `${category}: ${tools.length} 个工具`
        );
        UIList.simple(categoryStats);
      } catch (error: any) {
        spinner.fail('统计信息获取失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });

  // 测试工具
  toolsCmd
    .command('test <toolName>')
    .description('测试工具功能')
    .action(async toolName => {
      let spinner = UIProgress.spinner(`正在准备测试工具 "${toolName}"...`);
      spinner.start();

      try {
        const toolManager = await createToolManager();
        const tool = toolManager.getTool(toolName);

        if (!tool) {
          spinner.fail('工具不存在');
          UIDisplay.error(`工具 "${toolName}" 不存在`);
          return;
        }

        spinner.succeed('测试准备完成');

        UILayout.card('工具测试', [`工具名称: ${toolName}`, `描述: ${tool.description}`], {
          icon: '🧪',
        });

        // 生成测试参数
        const testParams = generateTestParams(tool);
        UIDisplay.info('生成的测试参数:');
        console.log(JSON.stringify(testParams, null, 2));

        const confirmed = await UIInput.confirm('确认使用这些参数进行测试？', { default: true });
        if (!confirmed) {
          UIDisplay.info('测试已取消');
          return;
        }

        spinner = UIProgress.spinner('正在执行测试...');
        spinner.start();

        const startTime = Date.now();
        const response = await toolManager.callTool({
          toolName,
          parameters: testParams,
        });
        const duration = Date.now() - startTime;

        spinner.succeed(`测试完成 (耗时: ${duration}ms)`);

        UIDisplay.section('测试结果');
        displayToolResult(response);
      } catch (error: any) {
        if (spinner) spinner.fail('测试失败');
        UIDisplay.error(`错误: ${error.message}`);
      }
    });
}

/**
 * 显示工具表格
 */
function displayToolsTable(tools: ToolDefinition[]): void {
  UIDisplay.section('🔧 可用工具列表');

  // 按分类分组
  const categories = tools.reduce(
    (acc, tool) => {
      const category = tool.category || '其他';
      if (!acc[category]) acc[category] = [];
      acc[category].push(tool);
      return acc;
    },
    {} as Record<string, ToolDefinition[]>
  );

  Object.entries(categories).forEach(([category, categoryTools]) => {
    UIDisplay.section(category);

    const toolList = categoryTools.map(tool => {
      const tags = tool.tags?.length ? ` (${tool.tags.join(', ')})` : '';
      return `${tool.name}: ${tool.description}${tags}`;
    });

    UIList.simple(toolList);
    UIDisplay.newline();
  });

  UIDisplay.info(`共找到 ${tools.length} 个工具`);
}

/**
 * 显示工具详细信息
 */
function displayToolInfo(tool: ToolDefinition): void {
  UILayout.card(
    `工具详情: ${tool.name}`,
    [
      `描述: ${tool.description}`,
      tool.category ? `分类: ${tool.category}` : null,
      tool.tags?.length ? `标签: ${tool.tags.join(', ')}` : null,
      tool.version ? `版本: ${tool.version}` : null,
    ].filter(Boolean) as string[],
    { icon: '🔧' }
  );

  if (tool.inputSchema) {
    UIDisplay.section('输入参数');

    if (tool.inputSchema.properties) {
      const params = Object.entries(tool.inputSchema.properties).map(
        ([name, schema]: [string, any]) => {
          const required = tool.inputSchema?.required?.includes(name) ? ' (必需)' : ' (可选)';
          const type = schema.type ? ` [${schema.type}]` : '';
          const desc = schema.description ? `: ${schema.description}` : '';
          return `${name}${required}${type}${desc}`;
        }
      );

      UIList.bullets(params);
    }
  }

  if (tool.outputSchema) {
    UIDisplay.section('输出格式');
    console.log(JSON.stringify(tool.outputSchema, null, 2));
  }

  if (tool.examples?.length) {
    UIDisplay.section('使用示例');
    tool.examples.forEach((example, index) => {
      UIDisplay.text(`示例 ${index + 1}:`);
      console.log(JSON.stringify(example, null, 2));
      UIDisplay.newline();
    });
  }
}

/**
 * 显示工具执行结果
 */
function displayToolResult(response: any): void {
  if (response.success) {
    UIDisplay.success('工具执行成功');

    if (response.data) {
      UIDisplay.section('执行结果');
      if (typeof response.data === 'string') {
        UIDisplay.text(response.data);
      } else {
        console.log(JSON.stringify(response.data, null, 2));
      }
    }

    if (response.metadata) {
      UIDisplay.section('元数据');
      console.log(JSON.stringify(response.metadata, null, 2));
    }
  } else {
    UIDisplay.error('工具执行失败');
    if (response.error) {
      UIDisplay.text(`错误信息: ${response.error}`);
    }
  }
}

/**
 * 生成工具文档
 */
function generateToolDocs(
  tools: ToolDefinition[],
  categories: Record<string, ToolDefinition[]>
): string {
  let docs = '# 工具文档\n\n';
  docs += `> 总计 ${tools.length} 个工具\n\n`;
  docs += '## 目录\n\n';

  // 生成目录
  for (const [category, categoryTools] of Object.entries(categories)) {
    docs += `- [${category.toUpperCase()}](#${category.toLowerCase()}) (${categoryTools.length})\n`;
  }
  docs += '\n';

  // 生成详细文档
  for (const [category, categoryTools] of Object.entries(categories)) {
    docs += `## ${category.toUpperCase()}\n\n`;

    for (const tool of categoryTools) {
      docs += `### ${tool.name}\n\n`;
      docs += `${tool.description}\n\n`;

      if (tool.version || tool.author) {
        docs += '**元信息:**\n';
        if (tool.version) docs += `- 版本: ${tool.version}\n`;
        if (tool.author) docs += `- 作者: ${tool.author}\n`;
        docs += '\n';
      }

      if (tool.tags && tool.tags.length > 0) {
        docs += `**标签:** \`${tool.tags.join('`、`')}\`\n\n`;
      }

      docs += '**参数:**\n\n';
      docs += '| 参数名 | 类型 | 必需 | 默认值 | 描述 |\n';
      docs += '|--------|------|------|--------|------|\n';

      for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
        const required = tool.required?.includes(paramName) ? '✅' : '❌';
        const defaultValue = paramSchema.default !== undefined ? `\`${paramSchema.default}\`` : '-';
        const description = paramSchema.description || '-';

        docs += `| \`${paramName}\` | \`${paramSchema.type}\` | ${required} | ${defaultValue} | ${description} |\n`;
      }

      docs += '\n---\n\n';
    }
  }

  return docs;
}

/**
 * 生成测试参数
 */
function generateTestParams(tool: ToolDefinition): Record<string, any> {
  const testParams: Record<string, any> = {};

  for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
    if (paramSchema.default !== undefined) {
      testParams[paramName] = paramSchema.default;
    } else if (paramSchema.enum && paramSchema.enum.length > 0) {
      testParams[paramName] = paramSchema.enum[0];
    } else {
      switch (paramSchema.type) {
        case 'string':
          testParams[paramName] = 'test';
          break;
        case 'number':
          testParams[paramName] = 42;
          break;
        case 'boolean':
          testParams[paramName] = true;
          break;
        case 'array':
          testParams[paramName] = [];
          break;
        case 'object':
          testParams[paramName] = {};
          break;
      }
    }
  }

  return testParams;
}
