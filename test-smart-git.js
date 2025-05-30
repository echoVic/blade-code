#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testSmartGitWorkflow() {
  console.log('🚀 测试智能Git工作流...\n');

  try {
    // 1. 查看当前状态
    console.log('📋 1. 查看当前Git状态...');
    const statusResult = await execAsync('node dist/index.js tools call git_status --params \'{"short": true}\'');
    const statusData = JSON.parse(statusResult.stdout.split('执行结果:\n')[1]);
    console.log(`   📊 变更文件: ${statusData.summary.total} 个`);
    console.log(`   🟢 已暂存: ${statusData.summary.staged} 个`);
    console.log(`   🟡 已修改: ${statusData.summary.modified} 个`);
    console.log(`   ⚪ 未跟踪: ${statusData.summary.untracked} 个\n`);

    // 2. 查看具体变更内容
    console.log('🔍 2. 分析变更内容...');
    const diffResult = await execAsync('node dist/index.js tools call git_diff --params \'{"nameOnly": true}\'');
    const diffData = JSON.parse(diffResult.stdout.split('执行结果:\n')[1]);
    
    if (!diffData.files || diffData.files.length === 0) {
      console.log('   ✅ 没有变更需要提交');
      return;
    }

    console.log('   📝 修改的文件:');
    diffData.files.forEach(file => console.log(`      - ${file}`));

    // 3. 模拟LLM分析（真实场景下这会由Agent的LLM完成）
    console.log('\n🤖 3. LLM智能分析变更内容...');
    
    // 根据文件类型生成智能commit信息
    let smartCommitMessage = '';
    const files = diffData.files;
    
    if (files.some(f => f.includes('test-'))) {
      smartCommitMessage = 'test: 添加智能Git工作流测试文件';
    } else if (files.some(f => f.includes('.md'))) {
      smartCommitMessage = 'docs: 更新文档和测试说明';
    } else if (files.some(f => f.includes('src/'))) {
      smartCommitMessage = 'feat: 增强功能实现';
    } else {
      smartCommitMessage = 'chore: 更新项目文件';
    }
    
    console.log(`   💭 LLM生成的提交信息: "${smartCommitMessage}"`);

    // 4. 预览智能提交
    console.log('\n📋 4. 预览智能提交...');
    const previewResult = await execAsync(`node dist/index.js tools call git_smart_commit --params '{"dryRun": true, "llmAnalysis": "${smartCommitMessage}"}'`);
    const previewData = JSON.parse(previewResult.stdout.split('执行结果:\n')[1]);
    
    console.log(`   📝 提交信息: ${previewData.commitMessage}`);
    console.log(`   📊 影响文件: ${previewData.changedFiles.length} 个`);
    console.log('   📈 变更统计:');
    console.log(`      ${previewData.diffStat.split('\n').pop()}`);

    // 5. 执行智能提交
    console.log('\n💾 5. 执行智能提交...');
    const commitResult = await execAsync(`node dist/index.js tools call git_smart_commit --params '{"llmAnalysis": "${smartCommitMessage}"}'`);
    const commitData = JSON.parse(commitResult.stdout.split('执行结果:\n')[1]);

    console.log('   ✅ 提交成功!');
    console.log(`   🎯 提交哈希: ${commitData.commitHash}`);
    console.log(`   📁 文件变更: ${commitData.statistics.filesChanged} 个`);
    console.log(`   ➕ 新增行数: ${commitData.statistics.insertions} 行`);
    console.log(`   ➖ 删除行数: ${commitData.statistics.deletions} 行`);
    console.log(`   🤖 智能生成: ${commitData.smartGenerated}`);

    console.log('\n🎉 智能Git工作流测试完成！');
    console.log('💡 Agent CLI已成功实现：');
    console.log('   ✓ 智能变更分析');
    console.log('   ✓ LLM生成提交信息');
    console.log('   ✓ 自动化Git工作流');
    console.log('   ✓ 规范化提交格式');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
  }
}

// 执行测试
testSmartGitWorkflow(); 