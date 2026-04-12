/**
 * AgentCreationWizard - Agent 创建向导
 *
 * 交互式多步骤表单，用于创建自定义 subagent 配置
 *
 * 步骤流程：
 * Step 1: 输入 Agent 名称（kebab-case）
 * Step 2: 输入描述信息
 * Step 3: 选择工具列表（多选）
 * Step 4: 选择背景颜色
 * Step 5: 选择配置位置（项目/用户）
 * Step 6: 输入系统提示词
 * Step 7: 确认并保存
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MultiSelect } from '@inkjs/ui';
import { useMemoizedFn } from 'ahooks';
import { Box, Text, useFocus, useFocusManager, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import type { SubagentColor } from '../../agent/subagents/types.js';
import { getCwd } from '../../utils/cwd.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface AgentCreationWizardProps {
  /** 完成回调 */
  onComplete: () => void;
  /** 取消回调 */
  onCancel: () => void;
  /** 编辑模式：传入现有配置 */
  initialConfig?: AgentConfig;
}

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  color?: SubagentColor;
  location: 'project' | 'user';
  systemPrompt: string;
}

type WizardStep =
  | 'mode' // 选择手动 or AI 生成
  | 'aiPrompt' // AI 生成：输入描述
  | 'aiGenerating' // AI 生成中
  | 'name'
  | 'description'
  | 'tools'
  | 'color'
  | 'location'
  | 'systemPrompt'
  | 'confirm';

// 可用工具列表
const AVAILABLE_TOOLS = [
  { label: 'Glob - 文件搜索', value: 'Glob' },
  { label: 'Grep - 内容搜索', value: 'Grep' },
  { label: 'Read - 读取文件', value: 'Read' },
  { label: 'Write - 写入文件', value: 'Write' },
  { label: 'Edit - 编辑文件', value: 'Edit' },
  { label: 'Bash - 执行命令', value: 'Bash' },
  { label: '所有工具 (不限制)', value: 'all' },
];

// 可用颜色
const AVAILABLE_COLORS: Array<{ label: string; value: SubagentColor | 'none' }> = [
  { label: '红色 (red)', value: 'red' },
  { label: '蓝色 (blue)', value: 'blue' },
  { label: '绿色 (green)', value: 'green' },
  { label: '黄色 (yellow)', value: 'yellow' },
  { label: '紫色 (purple)', value: 'purple' },
  { label: '橙色 (orange)', value: 'orange' },
  { label: '粉色 (pink)', value: 'pink' },
  { label: '青色 (cyan)', value: 'cyan' },
  { label: '不设置颜色', value: 'none' },
];

/**
 * 验证 agent 名称（kebab-case）
 */
function validateAgentName(name: string): string | null {
  if (!name || name.trim() === '') {
    return '名称不能为空';
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return '名称只能包含小写字母、数字和连字符';
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return '名称不能以连字符开头或结尾';
  }
  return null;
}

/**
 * Agent 创建向导主组件
 */
export function AgentCreationWizard({
  onComplete,
  onCancel,
  initialConfig,
}: AgentCreationWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>(
    initialConfig ? 'name' : 'mode' // 编辑模式跳过选择，直接进入手动配置
  );
  const [config, setConfig] = useState<AgentConfig>({
    name: initialConfig?.name || '',
    description: initialConfig?.description || '',
    tools: initialConfig?.tools || [],
    color: initialConfig?.color,
    location: initialConfig?.location || 'project',
    systemPrompt: initialConfig?.systemPrompt || '',
  });
  const [aiPrompt, setAiPrompt] = useState<string>('');
  const [aiGenerating, setAiGenerating] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string>('');
  const [workflowType, setWorkflowType] = useState<'manual' | 'ai' | 'edit'>(
    initialConfig ? 'edit' : 'manual'
  );

  const { focus } = useFocusManager();

  // 定义不同流程的步骤序列
  const workflows = {
    manual: [
      'mode',
      'name',
      'description',
      'tools',
      'color',
      'location',
      'systemPrompt',
      'confirm',
    ] as WizardStep[],
    ai: ['mode', 'aiPrompt', 'aiGenerating', 'confirm'] as WizardStep[],
    edit: [
      'name',
      'description',
      'tools',
      'color',
      'location',
      'systemPrompt',
      'confirm',
    ] as WizardStep[],
  };

  // 获取当前流程的步骤序列
  const currentWorkflow = workflows[workflowType];

  // 步骤切换时更新焦点
  useEffect(() => {
    if (
      currentStep === 'name' ||
      currentStep === 'description' ||
      currentStep === 'systemPrompt' ||
      currentStep === 'aiPrompt'
    ) {
      // TextInput 步骤不设置焦点（让其自然获得键盘控制）
      return;
    }
    // SelectInput 步骤设置焦点
    focus(`step-${currentStep}`);
  }, [currentStep, focus]);

  // 下一步
  const nextStep = useMemoizedFn(() => {
    const currentIndex = currentWorkflow.indexOf(currentStep);
    if (currentIndex < currentWorkflow.length - 1) {
      setCurrentStep(currentWorkflow[currentIndex + 1]);
    }
  });

  // 上一步
  const prevStep = useMemoizedFn(() => {
    // 重置 AI 错误状态（如果有）
    if (aiError) {
      setAiError('');
    }

    // 特殊处理: 从 confirm 返回时,如果在 AI 工作流,跳过 aiGenerating 直接回到 aiPrompt
    if (currentStep === 'confirm' && workflowType === 'ai') {
      setCurrentStep('aiPrompt');
      return;
    }

    const currentIndex = currentWorkflow.indexOf(currentStep);
    if (currentIndex > 0) {
      setCurrentStep(currentWorkflow[currentIndex - 1]);
    } else {
      // 已经是第一步，退出向导
      onCancel();
    }
  });

  // AI 生成配置
  const generateConfigWithAI = useMemoizedFn(async () => {
    setAiGenerating(true);
    setAiError('');

    try {
      // 创建一个新的 Agent 实例用于 AI 生成
      const agent = await Agent.create();

      // 构建系统提示
      const systemPrompt = `你是一个 Subagent 配置生成专家。用户会描述他们想要创建的 agent，你需要根据描述生成一个完整的 agent 配置。

## 可用工具列表

- **Glob**: 文件模式匹配（例如：查找所有 .ts 文件）
- **Grep**: 代码内容搜索（例如：搜索特定函数调用）
- **Read**: 读取文件内容
- **Write**: 写入/创建文件
- **Edit**: 编辑文件（字符串替换）
- **Bash**: 执行命令行命令

## 可用颜色

- red, blue, green, yellow, purple, orange, pink, cyan

## 输出格式

你必须以 JSON 格式返回配置，格式如下：

\`\`\`json
{
  "name": "agent-name",
  "description": "简洁的一句话描述（英文）",
  "tools": ["Glob", "Grep", "Read"],
  "color": "blue",
  "systemPrompt": "详细的系统提示词，说明这个 agent 的职责、工作方式、输出格式等"
}
\`\`\`

## 注意事项

1. **name**: 只能包含小写字母、数字和连字符（kebab-case），例如：code-reviewer
2. **description**: 一句话说明用途，建议以 "Fast agent specialized for..." 开头
3. **tools**: 根据任务选择必要的工具，不要选择太多
4. **color**: 选择一个合适的颜色用于 UI 区分
5. **systemPrompt**: 详细说明 agent 的职责、使用的工具、输出格式等，使用 Markdown 格式

**重要**：请直接返回 JSON，不要添加任何额外的解释或文字。`;

      // 调用 LLM 生成配置
      const response = await agent.chatWithSystem(systemPrompt, aiPrompt);

      // 解析响应
      let jsonStr = response.trim();

      // 移除 markdown 代码块标记
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
      }

      const parsed = JSON.parse(jsonStr);

      // 验证必需字段
      if (!parsed.name || !parsed.description || !parsed.systemPrompt) {
        throw new Error('Missing required fields: name, description, or systemPrompt');
      }

      // 验证 name 格式（kebab-case）
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.name)) {
        throw new Error(
          'Invalid name format. Must be kebab-case (lowercase, numbers, hyphens only)'
        );
      }

      // 将生成的配置应用到 config 状态
      setConfig({
        name: parsed.name,
        description: parsed.description,
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        color: parsed.color || 'blue',
        location: 'project', // 默认项目级
        systemPrompt: parsed.systemPrompt,
      });

      // 跳转到确认步骤
      setCurrentStep('confirm');
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiGenerating(false);
    }
  });

  // 当进入 aiGenerating 步骤时触发 AI 生成
  useEffect(() => {
    if (currentStep === 'aiGenerating' && !aiGenerating && !aiError) {
      generateConfigWithAI();
    }
  }, [currentStep, aiGenerating, aiError, generateConfigWithAI]);

  // 保存配置
  const saveConfig = useMemoizedFn(async () => {
    try {
      // 确定保存路径
      const baseDir =
        config.location === 'project'
          ? path.join(getCwd(), '.blade', 'agents')
          : path.join(os.homedir(), '.blade', 'agents');

      // 确保目录存在
      await fs.promises.mkdir(baseDir, { recursive: true });

      // 生成文件内容
      const frontmatter = [
        '---',
        `name: ${config.name}`,
        `description: ${config.description}`,
      ];

      // 添加工具列表（如果不是"所有工具"）
      if (config.tools.length > 0 && !config.tools.includes('all')) {
        frontmatter.push('tools:');
        for (const tool of config.tools) {
          frontmatter.push(`  - ${tool}`);
        }
      }

      // 添加颜色（如果设置了）
      if (config.color) {
        frontmatter.push(`color: ${config.color}`);
      }

      frontmatter.push('---');

      const fileContent = [
        frontmatter.join('\n'),
        '',
        `# ${config.name} Subagent`,
        '',
        config.systemPrompt || '你是一个专门的代理，负责执行特定任务。',
        '',
      ].join('\n');

      // 写入文件
      const filePath = path.join(baseDir, `${config.name}.md`);
      await fs.promises.writeFile(filePath, fileContent, 'utf-8');

      onComplete();
    } catch (error) {
      // TODO: 显示错误消息
      console.error('保存配置失败:', error);
    }
  });

  // 使用智能 Ctrl+C 处理（向导没有执行中状态，直接退出）
  const handleCtrlC = useCtrlCHandler(false, onCancel);

  // ESC 键处理：返回上一步
  // Ctrl+C 处理：智能退出
  // 注意：tools 步骤由 ToolsSelectionStep 自己处理 ESC
  useInput(
    (input, key) => {
      if (key.escape) {
        prevStep(); // prevStep 内部会判断是否是第一步，如果是则调用 onCancel()
      } else if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
      }
    },
    { isActive: currentStep !== 'tools' }
  );

  // 步骤 0: 选择创建模式
  if (currentStep === 'mode') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            选择创建方式
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>你可以手动配置每个细节，或让 AI 根据你的描述自动生成配置</Text>
        </Box>
        <SelectInput
          items={[
            {
              label: 'AI 智能生成 - 根据描述自动生成完整配置',
              value: 'ai',
            },
            { label: '手动配置 - 逐步配置每个选项', value: 'manual' },
          ]}
          onSelect={(item) => {
            if (item.value === 'ai') {
              setWorkflowType('ai');
              setCurrentStep('aiPrompt');
            } else {
              setWorkflowType('manual');
              setCurrentStep('name');
            }
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>使用方向键选择 | Enter 确认 | ESC 取消</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 AI.1: AI 生成提示词输入
  if (currentStep === 'aiPrompt') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            AI 智能生成
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            描述你想要创建的 Agent（例如："一个专门用于代码审查的
            agent，能够分析代码质量和潜在bug"）
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="green">描述: </Text>
          <TextInput
            value={aiPrompt}
            onChange={setAiPrompt}
            onSubmit={(value) => {
              if (!value.trim()) {
                return;
              }
              setCurrentStep('aiGenerating');
            }}
          />
        </Box>
        <Box>
          <Text dimColor>按 Enter 开始生成 | ESC 返回</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 AI.2: AI 生成中
  if (currentStep === 'aiGenerating') {
    if (aiError) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box marginBottom={1}>
            <Text bold color="red">
              AI 生成失败
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color="red">{aiError}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>按 ESC 返回修改描述</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="yellow">
            <Spinner type="dots" /> AI 正在生成配置...
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>根据你的描述："{aiPrompt}"</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="gray">正在调用 LLM 生成 agent 配置，请稍候...</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 1: 名称输入
  if (currentStep === 'name') {
    const isEditMode = workflowType === 'edit';

    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 1/7: {isEditMode ? 'Agent 名称（不可修改）' : '输入 Agent 名称'}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            {isEditMode
              ? '编辑模式下名称不可修改（修改名称相当于创建新 Agent）'
              : '名称只能包含小写字母、数字和连字符（例如：code-reviewer）'}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="green">名称: </Text>
          {isEditMode ? (
            <Text>{config.name}</Text>
          ) : (
            <TextInput
              value={config.name}
              onChange={(value) => setConfig({ ...config, name: value })}
              onSubmit={(value) => {
                const error = validateAgentName(value);
                if (error) {
                  // TODO: 显示错误提示
                  return;
                }
                nextStep();
              }}
            />
          )}
        </Box>
        <Box>
          <Text dimColor>
            {isEditMode ? '按 Enter 继续 | ESC 返回' : '按 Enter 继续 | ESC 返回'}
          </Text>
        </Box>
        {isEditMode && (
          <TextInput
            key="edit-mode-dummy-input"
            value=""
            onChange={() => {
              // 编辑模式下的隐藏输入，仅用于捕获 Enter 键
            }}
            onSubmit={nextStep}
            showCursor={false}
          />
        )}
      </Box>
    );
  }

  // 步骤 2: 描述输入
  if (currentStep === 'description') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 2/7: 输入描述信息
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            简短描述这个 Agent 的用途和使用场景（这将帮助主 Agent 决定何时使用它）
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="green">描述: </Text>
          <TextInput
            value={config.description}
            onChange={(value) => setConfig({ ...config, description: value })}
            onSubmit={(value) => {
              if (!value.trim()) {
                return;
              }
              nextStep();
            }}
          />
        </Box>
        <Box>
          <Text dimColor>按 Enter 继续 | ESC 返回</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 3: 工具选择
  if (currentStep === 'tools') {
    return (
      <ToolsSelectionStep
        config={config}
        setConfig={setConfig}
        onNext={nextStep}
        onPrev={prevStep}
      />
    );
  }

  // 步骤 4: 颜色选择
  if (currentStep === 'color') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 4/7: 选择背景颜色
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            为 Agent 选择一个颜色标识（用于在 UI 中区分不同的 Agents）
          </Text>
        </Box>
        <SelectInput
          items={AVAILABLE_COLORS}
          onSelect={(item) => {
            const color =
              item.value === 'none' ? undefined : (item.value as SubagentColor);
            setConfig({ ...config, color });
            nextStep();
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>使用方向键选择 | Enter 确认 | ESC 返回</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 5: 位置选择
  if (currentStep === 'location') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 5/7: 选择保存位置
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>项目级配置仅在当前项目生效，用户级配置全局可用</Text>
        </Box>
        <SelectInput
          items={[
            {
              label: '项目级 (.blade/agents/) - 仅当前项目',
              value: 'project',
            },
            {
              label: '用户级 (~/.blade/agents/) - 全局可用',
              value: 'user',
            },
          ]}
          onSelect={(item) => {
            setConfig({ ...config, location: item.value as 'project' | 'user' });
            nextStep();
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>使用方向键选择 | Enter 确认 | ESC 返回</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 6: 系统提示词
  if (currentStep === 'systemPrompt') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 6/7: 输入系统提示词
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>定义 Agent 的行为和职责（可选，留空将使用默认提示）</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="green">提示词: </Text>
          <TextInput
            value={config.systemPrompt}
            onChange={(value) => setConfig({ ...config, systemPrompt: value })}
            onSubmit={() => nextStep()}
          />
        </Box>
        <Box>
          <Text dimColor>按 Enter 继续 | ESC 返回</Text>
        </Box>
      </Box>
    );
  }

  // 步骤 7: 确认
  if (currentStep === 'confirm') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Step 7/7: 确认配置
          </Text>
        </Box>

        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          <Text>
            <Text bold color="green">
              名称:{' '}
            </Text>
            <Text>{config.name}</Text>
          </Text>
          <Text>
            <Text bold color="green">
              描述:{' '}
            </Text>
            <Text>{config.description}</Text>
          </Text>
          <Text>
            <Text bold color="green">
              工具:{' '}
            </Text>
            <Text>
              {config.tools.includes('all')
                ? '所有工具'
                : config.tools.join(', ') || '所有工具'}
            </Text>
          </Text>
          <Text>
            <Text bold color="green">
              颜色:{' '}
            </Text>
            <Text>{config.color || '默认'}</Text>
          </Text>
          <Text>
            <Text bold color="green">
              位置:{' '}
            </Text>
            <Text>{config.location === 'project' ? '项目级' : '用户级'}</Text>
          </Text>
          <Text>
            <Text bold color="green">
              提示词:{' '}
            </Text>
            <Text>{config.systemPrompt || '(使用默认)'}</Text>
          </Text>
        </Box>

        <SelectInput
          items={[
            { label: '确认并保存', value: 'save' },
            { label: '返回上一步', value: 'back' },
            { label: '取消', value: 'cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === 'save') {
              saveConfig();
            } else if (item.value === 'back') {
              prevStep();
            } else {
              onCancel();
            }
          }}
        />
      </Box>
    );
  }

  return null;
}

/**
 * 工具选择步骤组件（多选）
 */
interface ToolsSelectionStepProps {
  config: AgentConfig;
  setConfig: (config: AgentConfig) => void;
  onNext: () => void;
  onPrev: () => void;
}

function ToolsSelectionStep({
  config,
  setConfig,
  onNext,
  onPrev,
}: ToolsSelectionStepProps) {
  const { isFocused } = useFocus({ id: 'step-tools' });

  // 处理 ESC 键返回上一步
  useInput(
    (_input, key) => {
      if (key.escape) {
        onPrev();
      }
    },
    { isActive: isFocused }
  );

  const handleSubmit = (selectedValues: string[]) => {
    // 如果选择了"所有工具"，只保留 'all'
    if (selectedValues.includes('all')) {
      setConfig({ ...config, tools: ['all'] });
    } else {
      setConfig({ ...config, tools: selectedValues });
    }

    onNext();
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Step 3/7: 选择可用工具
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          方向键导航，空格切换勾选，Enter 确认进入下一步 | ESC 返回上一步
        </Text>
      </Box>
      <MultiSelect
        options={AVAILABLE_TOOLS}
        defaultValue={config.tools}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
