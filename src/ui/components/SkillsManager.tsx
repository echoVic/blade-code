/**
 * SkillsManager - Skills 查看器
 *
 * 显示所有可用的 Skills 及其详细信息
 */

import { Box, Text, useInput } from 'ink';
import { getSkillRegistry } from '../../skills/index.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

export interface SkillsManagerProps {
  /** 完成回调 */
  onComplete?: () => void;
  /** 取消回调 */
  onCancel?: () => void;
}

/**
 * Skills 查看器主组件
 */
export function SkillsManager({ onCancel }: SkillsManagerProps) {
  const registry = getSkillRegistry();
  const skills = registry.getAll();

  // 按来源分组
  const builtinSkills = skills.filter((s) => s.source === 'builtin');
  const userSkills = skills.filter((s) => s.source === 'user');
  const projectSkills = skills.filter((s) => s.source === 'project');

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(false, onCancel);

  // ESC 和 Ctrl+C 处理
  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
    } else if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
      handleCtrlC();
    }
  });

  if (skills.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            📚 所有 Skills
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray">没有找到任何 Skill</Text>
        </Box>
        <Box marginTop={1} paddingLeft={2}>
          <Text color="gray">配置文件位置: ~/.blade/skills/ 或 .blade/skills/</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>按 ESC 返回菜单</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📚 所有 Skills
        </Text>
        <Text color="gray"> (找到 {skills.length} 个)</Text>
      </Box>

      {/* 项目级 Skills */}
      {projectSkills.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="yellow">
              项目级
            </Text>
            <Text color="gray"> (.blade/skills/)</Text>
          </Box>
          {projectSkills.map((skill) => {
            const maxDescLen = 80;
            const desc =
              skill.description.length > maxDescLen
                ? `${skill.description.substring(0, maxDescLen)}...`
                : skill.description;
            return (
              <Box key={skill.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    • {skill.name}
                  </Text>
                  <Text color="gray"> - {desc}</Text>
                </Text>
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text color="gray">工具: {skill.allowedTools.join(', ')}</Text>
                  </Box>
                )}
                <Box paddingLeft={2}>
                  <Text color="gray" dimColor>
                    {skill.path}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* 用户级 Skills */}
      {userSkills.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="yellow">
              用户级
            </Text>
            <Text color="gray"> (~/.blade/skills/)</Text>
          </Box>
          {userSkills.map((skill) => {
            const maxDescLen = 80;
            const desc =
              skill.description.length > maxDescLen
                ? `${skill.description.substring(0, maxDescLen)}...`
                : skill.description;
            return (
              <Box key={skill.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    • {skill.name}
                  </Text>
                  <Text color="gray"> - {desc}</Text>
                </Text>
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <Box paddingLeft={2}>
                    <Text color="gray">工具: {skill.allowedTools.join(', ')}</Text>
                  </Box>
                )}
                <Box paddingLeft={2}>
                  <Text color="gray" dimColor>
                    {skill.path}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* 内置 Skills */}
      {builtinSkills.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingLeft={1}>
            <Text bold color="cyan">
              内置
            </Text>
            <Text color="gray"> (builtin)</Text>
          </Box>
          {builtinSkills.map((skill) => {
            // 截断过长的描述
            const maxDescLen = 80;
            const desc =
              skill.description.length > maxDescLen
                ? `${skill.description.substring(0, maxDescLen)}...`
                : skill.description;
            return (
              <Box key={skill.name} flexDirection="column" paddingLeft={2}>
                <Text>
                  <Text bold color="green">
                    • {skill.name}
                  </Text>
                  <Text color="gray"> - {desc}</Text>
                </Text>
                {skill.userInvocable && (
                  <Box paddingLeft={2}>
                    <Text color="blue">命令: /{skill.name}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>按 ESC 返回菜单</Text>
      </Box>
    </Box>
  );
}
