/**
 * usePhraseCycler Hook
 * 管理加载时显示的短语循环
 *
 * 功能：
 * - 简洁的加载动词短语
 * - 每 15 秒自动切换
 * - 1/4 概率显示实用提示，3/4 概率显示加载短语
 */

import { useEffect, useState } from 'react';

// 切换间隔：15 秒
const PHRASE_CHANGE_INTERVAL_MS = 15000;

/**
 * 加载短语列表 - 简洁、专业、略带趣味
 * 采用「动词 + ing」式的简短表达
 */
const WITTY_LOADING_PHRASES = [
  // 思考类
  '思考中',
  '构思中',
  '推理中',
  '琢磨中',
  '分析中',
  '斟酌中',
  '酝酿中',
  '推敲中',
  '揣摩中',
  '审视中',

  // 工作类
  '处理中',
  '编排中',
  '打磨中',
  '编织中',
  '拼装中',
  '调配中',
  '组装中',
  '搭建中',
  '铸造中',
  '雕琢中',

  // 探索类
  '搜寻中',
  '梳理中',
  '排查中',
  '勘探中',
  '钻研中',
  '翻阅中',
  '遍历中',
  '扫描中',
  '检索中',
  '追踪中',

  // 计算类
  '计算中',
  '编译中',
  '解析中',
  '运算中',
  '推演中',
  '迭代中',
  '收敛中',
  '演绎中',
  '归纳中',
  '求解中',

  // 创造类
  '生成中',
  '编写中',
  '起草中',
  '绘制中',
  '勾勒中',
  '渲染中',
  '合成中',
  '调和中',
  '编曲中',
  '烹制中',

  // 轻松趣味
  '施工中',
  '酿造中',
  '发酵中',
  '煎熬中',
  '折腾中',
  '捣鼓中',
  '鼓捣中',
  '腾挪中',
  '筹备中',
  '蓄力中',
];

/**
 * 实用提示信息 - 快捷键和常用命令
 */
const INFORMATIVE_TIPS = [
  // 快捷键
  'Esc - 中止任务 / 隐藏建议 / 双击清空输入',
  'Shift+Tab - 切换模式 (DEFAULT → AUTO_EDIT → PLAN)',
  'Tab - 选中建议 / 切换 thinking 模式',
  'Up/Down - 浏览建议或输入历史',
  '? - 显示快捷键帮助（输入框为空时）',
  'Ctrl+C - 停止任务（双击退出）',
  'Ctrl+L - 清屏',
  'Ctrl+T - 展开/折叠 thinking 内容',
  'Ctrl+O - 展开/折叠历史消息',
  'Ctrl+A / Ctrl+E - 光标跳到行首/行尾',
  'Ctrl+U / Ctrl+K - 删到行首/行尾',
  'Ctrl+W - 删除前一个单词',
  'Shift+Enter - 插入换行',

  // 斜杠命令
  '/help - 显示所有可用命令',
  '/init - 分析项目并生成 BLADE.md',
  '/resume - 恢复历史会话',
  '/compact - 压缩上下文，节省 token',
  '/theme - 切换主题',
  '/model - 管理和切换模型',
  '/permissions - 管理权限规则',
  '/mcp - 查看 MCP 服务器状态',
  '/agents - 管理 subagent 配置',
  '/clear - 清除对话历史',
  '/status - 查看当前配置',
  '/context - 可视化 token 使用情况',
  '/git - Git 查询和 AI 辅助',
  '/git review - AI Code Review',
  '/git commit - AI 生成 commit message',
  '/hooks - 管理 Hook 配置',
  '/tasks - 查看后台任务',
  '/skills - 查看可用 Skills',
  '/plugins - 管理插件',
  '/memory - 管理项目记忆',
  '/ide - 管理 IDE 集成',

  // 高级功能
  '@ 文件路径 - 附加文件到上下文',
  '@dir/ - 附加整个目录',
  '@file.ts:10-20 - 附加指定行范围',
  'Plan 模式 - 先规划后编码（Shift+Tab 切换）',
  'Auto Edit 模式 - 自动批准工具调用',
  'MCP 协议 - 扩展外部工具集成',
  'Subagents - 并行执行子任务',
  'Hooks - 自定义工具执行流程',
  'Skills - 可复用的技能模板',
  'Plugins - 扩展功能插件',

  // 最佳实践
  '提示：/init 让 AI 理解你的项目结构',
  '提示：Plan 模式适合复杂多步骤任务',
  '提示：Auto Edit 可加速重复性操作',
  '提示：@ 引用可提供更精准的上下文',
  '提示：定期 /compact 节省 token',
  '提示：Esc 可随时中断任务',
  '提示：/resume 继续未完成的对话',
  '提示：/model once 临时切换模型',
];

/**
 * usePhraseCycler Hook
 *
 * @param isActive - 是否激活短语循环（通常在 Agent 处理中时为 true）
 * @param isWaiting - 是否等待用户确认（显示固定等待文本）
 * @param paused - 是否暂停短语切换（当被弹窗遮挡时使用）
 * @returns 当前显示的短语
 */
export function usePhraseCycler(
  isActive: boolean,
  isWaiting: boolean,
  paused = false
): string {
  const [currentPhrase, setCurrentPhrase] = useState<string>('');

  useEffect(() => {
    // 等待确认时显示固定文本
    if (isWaiting) {
      setCurrentPhrase('等待用户确认...');
      return;
    }

    // 未激活时不显示短语
    if (!isActive) {
      setCurrentPhrase('');
      return;
    }

    // 暂停时保持当前短语，不启动新的定时器
    if (paused) {
      return;
    }

    // 随机选择一个短语（首次加载）
    const selectRandomPhrase = () => {
      // 1/4 概率显示实用提示，3/4 概率显示加载短语
      const showTip = Math.random() < 1 / 4;
      if (showTip) {
        const randomIndex = Math.floor(Math.random() * INFORMATIVE_TIPS.length);
        return INFORMATIVE_TIPS[randomIndex];
      }

      const randomIndex = Math.floor(Math.random() * WITTY_LOADING_PHRASES.length);
      return WITTY_LOADING_PHRASES[randomIndex];
    };

    // 初始化短语
    setCurrentPhrase(selectRandomPhrase());

    // 每 15 秒切换一次
    const intervalId = setInterval(() => {
      setCurrentPhrase(selectRandomPhrase());
    }, PHRASE_CHANGE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [isActive, isWaiting, paused]);

  return currentPhrase;
}
