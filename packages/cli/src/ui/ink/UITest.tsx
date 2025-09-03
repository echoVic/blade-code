/**
 * Ink UI 组件测试
 */
import { render } from 'ink';
import React, { useEffect, useState } from 'react';
import { Animation } from './Animation.js';
import { Box } from './Box.js';
import { Button } from './Button.js';
import { Display } from './Display.js';
import { Input } from './Input.js';
import { Layout } from './Layout.js';
import { memoryLeakDetector, useLeakDetection } from './MemoryLeakDetector.js';
import { memoryManager } from './MemoryManager.js';
import { PerformanceProvider, usePerformanceMonitor } from './PerformanceOptimizer.js';
import { ProgressBar } from './ProgressBar.js';
import { ResponsiveProvider, useBreakpoint, useTerminalSize } from './ResponsiveAdapter.js';
import { Spinner } from './Spinner.js';
import { Text } from './Text.js';
import { useMemoryCleanup } from './useMemoryCleanup.js';
import { VirtualScroll } from './VirtualScroll.js';

// 测试数据
const testData = Array.from({ length: 1000 }, (_, i) => `测试项目 ${i + 1}`);

// 主测试组件
const TestApp = () => {
  const [inputValue, setInputValue] = useState('');
  const [buttonPressed, setButtonPressed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [animationType, setAnimationType] = useState('fadeIn');
  
  // 内存清理测试
  useMemoryCleanup('TestApp', 1024, () => {
    console.log('TestApp 组件清理完成');
  });
  
  // 内存泄漏检测
  useLeakDetection('TestApp');
  
  // 性能监控
  const { startMeasurement, endMeasurement } = usePerformanceMonitor();
  
  // 启动性能测量
  useEffect(() => {
    startMeasurement();
  }, [startMeasurement]);
  
  // 模拟进度更新
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress(prev => (prev >= 1 ? 0 : prev + 0.1));
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);
  
  // 响应式信息
  const breakpoint = useBreakpoint();
  const terminalSize = useTerminalSize();
  
  // 渲染测试项目
  const renderTestItem = (item: string, index: number) => (
    <Box key={index} paddingX={1} paddingY={0}>
      <Text color="blue">•</Text>
      <Text> {item}</Text>
    </Box>
  );
  
  return (
    <ResponsiveProvider>
      <PerformanceProvider>
        <Box flexDirection="column" padding={1}>
          {/* 头部 */}
          <Layout type="header" title="Blade UI 测试" border>
            <Text>响应式断点: {breakpoint}</Text>
            <Text>终端尺寸: {terminalSize.columns} x {terminalSize.rows}</Text>
          </Layout>
          
          {/* 基础组件测试 */}
          <Box flexDirection="column" marginBottom={1}>
            <Display type="header" content="基础组件测试" />
            
            {/* 文本和按钮 */}
            <Box flexDirection="row" marginTop={1}>
              <Text>输入测试: </Text>
              <Input 
                value={inputValue}
                placeholder="请输入文本..."
                onChange={setInputValue}
                focus
              />
              <Box marginLeft={1}>
                <Button 
                  onPress={() => setButtonPressed(!buttonPressed)}
                  color={buttonPressed ? "white" : "black"}
                  backgroundColor={buttonPressed ? "green" : "blue"}
                >
                  {buttonPressed ? "已按下" : "按钮"}
                </Button>
              </Box>
            </Box>
            
            {/* 显示组件测试 */}
            <Box flexDirection="column" marginTop={1}>
              <Display type="success" content={`成功消息: ${inputValue}`} />
              <Display type="error" content="错误消息" />
              <Display type="warning" content="警告消息" />
              <Display type="info" content="信息消息" />
              <Display type="highlight" content="高亮文本" />
            </Box>
          </Box>
          
          {/* 动画和加载组件测试 */}
          <Box flexDirection="column" marginBottom={1}>
            <Display type="header" content="动画和加载组件测试" />
            
            <Box flexDirection="row" marginTop={1}>
              <Box marginRight={2}>
                <Text>进度条: </Text>
                <ProgressBar progress={progress} showPercentage width={20} />
              </Box>
              
              <Box marginRight={2}>
                <Text>加载动画: </Text>
                <Spinner type="dots" label="加载中" />
              </Box>
            </Box>
            
            <Box marginTop={1}>
              <Text>动画效果: </Text>
              <Animation type={animationType as any} duration={2000} loop>
                <Text color="green">这是一个动画文本</Text>
              </Animation>
              <Box flexDirection="row" marginTop={1}>
                <Button onPress={() => setAnimationType('fadeIn')}>淡入</Button>
                <Box marginLeft={1}>
                  <Button onPress={() => setAnimationType('slideIn')}>滑入</Button>
                </Box>
                <Box marginLeft={1}>
                  <Button onPress={() => setAnimationType('pulse')}>脉冲</Button>
                </Box>
              </Box>
            </Box>
          </Box>
          
          {/* 布局组件测试 */}
          <Box flexDirection="column" marginBottom={1}>
            <Display type="header" content="布局组件测试" />
            
            <Layout type="card" title="卡片布局测试" border margin={1}>
              <Text>这是一个卡片布局测试</Text>
            </Layout>
            
            <Layout type="divider" title="分隔线测试" margin={1} />
          </Box>
          
          {/* 虚拟滚动测试 */}
          <Box flexDirection="column" marginBottom={1}>
            <Display type="header" content="虚拟滚动测试" />
            
            <Box height={10} marginTop={1}>
              <VirtualScroll
                items={testData}
                renderItem={renderTestItem}
                config={{
                  itemHeight: 1,
                  overscanCount: 5,
                  containerHeight: 10,
                }}
              />
            </Box>
          </Box>
          
          {/* 性能和内存信息 */}
          <Box flexDirection="column">
            <Display type="header" content="性能和内存信息" />
            
            <Box flexDirection="row" marginTop={1}>
              <Box marginRight={2}>
                <Text>内存使用: </Text>
                <Text color="blue">
                  {(memoryManager.getMemoryUsage().total / 1024 / 1024).toFixed(2)} MB
                </Text>
              </Box>
              
              <Box>
                <Text>组件数量: </Text>
                <Text color="green">
                  {memoryManager.getMemoryUsage().components.size}
                </Text>
              </Box>
            </Box>
            
            <Box marginTop={1}>
              <Button onPress={() => memoryManager.forceCleanup()}>
                强制内存清理
              </Button>
              <Box marginLeft={1}>
                <Button onPress={() => memoryLeakDetector.forceGcAndCheck()}>
                  检查内存泄漏
                </Button>
              </Box>
            </Box>
          </Box>
          
          {/* 底部 */}
          <Layout type="footer" title="测试完成" border />
        </Box>
      </PerformanceProvider>
    </ResponsiveProvider>
  );
};

// 运行测试
export const runUITest = () => {
  console.log('启动 UI 组件测试...');
  
  // 启用内存泄漏检测
  memoryLeakDetector.enableLeakDetection();
  
  // 渲染测试应用
  const { unmount } = render(<TestApp />);
  
  // 30秒后自动卸载
  setTimeout(() => {
    console.log('测试完成，卸载应用...');
    unmount();
    
    // 显示最终内存报告
    console.log(memoryManager.getMemoryReport());
    console.log(memoryLeakDetector.getLeakReport());
  }, 30000);
};

export default TestApp;