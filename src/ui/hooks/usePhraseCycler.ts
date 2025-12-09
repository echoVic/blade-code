/**
 * usePhraseCycler Hook
 * 管理加载时显示的幽默短语循环
 *
 * 功能：
 * - 195 条编程术语 × 中国风/武侠/修仙主题
 * - 每 15 秒自动切换
 * - 5/6 概率显示幽默短语，1/6 概率显示实用提示
 */

import { useEffect, useState } from 'react';

// 切换间隔：15 秒
const PHRASE_CHANGE_INTERVAL_MS = 15000;

/**
 * 幽默短语列表 - 编程术语 × 中国风/武侠/修仙
 * 将计算机概念用修真世界的方式表达
 */
export const WITTY_LOADING_PHRASES = [
  // 修仙风 - 代码炼化 (30条)
  '炼化代码灵气...',
  '参悟 AST 道法...',
  '推演算法天机...',
  '重铸代码根基...',
  '破解逻辑封印...',
  '凝练类型真元...',
  '铸就函数金丹...',
  '渡劫编译雷劫...',
  '打通模块任督二脉...',
  '修炼 Tree-shaking 神功...',
  '压缩代码乾坤...',
  '布下 Source Map 阵法...',
  '推演 Token 灵数...',
  '炼制 Prompt 仙丹...',
  '调息温度参数...',
  '参透困惑度玄机...',
  '驱动 LLM 灵力...',
  '施展向量搜索术...',
  '构筑 RAG 法阵...',
  '凝聚 Embedding 道果...',
  '勾连向量宝库...',
  '破译函数咒语...',
  '验证 Schema 真意...',
  '封印工具参数...',
  '注入系统道韵...',
  '串联历史因果...',
  '炼化抽象语法树...',
  '破境重构神功...',
  '感悟类型天道...',
  '筑基模块根基...',

  // 武侠风 - 编译运行 (25条)
  '施展词法轻功...',
  '破解语法阵法...',
  '参悟语义心法...',
  '凝练中间内力...',
  '修炼优化神功 (O3)...',
  '调息寄存器真气...',
  '运转指令招式...',
  '消除死码杂念...',
  '折叠常量真元...',
  '内联函数身法...',
  '逃逸分析密探...',
  '垃圾回收扫地僧...',
  '标记清除掌法...',
  '分代回收心诀...',
  '增量收功法门...',
  'JIT 即时顿悟...',
  '解读字节码暗器...',
  'V8 引擎神功...',
  '召唤 WASM 傀儡...',
  '开辟虚拟洞府...',
  '丹田分配内存...',
  '掌控栈帧乾坤...',
  '捕获异常剑气...',
  '尾调优化身法...',
  '动态链接飞剑...',

  // 网络修真 - 协议传输 (20条)
  '建立 TCP 金桥...',
  '三次握手结契...',
  '传送 HTTP 飞书...',
  '破译响应符文...',
  'TLS 秘境握手...',
  '验证 SSL 信物...',
  'WebSocket 通灵...',
  '流式传功大法...',
  'gRPC 御剑飞行...',
  'Protobuf 封印术...',
  'GraphQL 问道...',
  'DNS 测算域名...',
  '负载均衡五行阵...',
  'CDN 边缘瞬移...',
  'HTTP/2 分身术...',
  'QUIC 闪现神通...',
  'gzip 缩地成寸...',
  'Brotli 玄冰压缩...',
  '断点续传接续术...',
  '分片上传合璧功...',

  // 数据修炼 - 存储查询 (20条)
  '参研 SQL 真经...',
  '推演查询路径...',
  '索引扫描神识...',
  '全表扫描暴力突破...',
  '执行 JOIN 双修大法...',
  '聚合数据炼丹...',
  '事务提交天地誓...',
  'ACID 四象护法...',
  '乐观锁道心无畏...',
  '悲观锁剑阵守护...',
  '分布式锁万里封禁...',
  'Redis 炼药鼎缓存...',
  'LRU 新陈代谢...',
  'WAL 预写因果簿...',
  'B+ 树平衡阴阳...',
  'LSM 树合璧压缩...',
  '向量宝库搜寻...',
  '余弦相似度测算...',
  'KNN 近邻追踪...',
  '倒排索引翻阅秘籍...',

  // 算法武学 - 剑法刀法 (20条)
  '快速排序剑法...',
  '归并排序双刀...',
  '堆排优化内功...',
  '二分查找闪现...',
  '深度优先潜行...',
  '广度优先横扫...',
  'Dijkstra 寻路神算...',
  'A* 天机推演...',
  '动态规划填棋盘...',
  '回溯剑法剪枝...',
  '贪心策略奇谋...',
  '分治递归化身术...',
  '哈希表扩容开天...',
  '红黑树旋转太极...',
  'AVL 树平衡阴阳...',
  '跳表纵身轻功...',
  'Trie 树千头万绪...',
  '布隆过滤天罗地网...',
  '一致性哈希环定乾坤...',
  '最小生成树扎根...',

  // 江湖部署 - DevOps (20条)
  'Docker 镜像炼制...',
  'Kubernetes 调兵遣将...',
  '容器结界布阵...',
  '卷挂载空间挪移...',
  'Helm 符箓展开...',
  'CI/CD 流水线作业...',
  'GitHub 门派行动...',
  '代码品鉴术...',
  '漏洞探查密探...',
  '依赖追溯寻根...',
  '蓝绿部署换防...',
  '金丝雀试探...',
  '回滚时光倒流...',
  '健康探查望闻问切...',
  '日志归档藏经阁...',
  '监控预警千里眼...',
  '告警通知飞鸽传书...',
  '性能调优筋骨重塑...',
  '扩容缩容易筋经...',
  '灰度发布声东击西...',

  // 前端修炼 - UI 渲染 (20条)
  'React 虚影对决...',
  '组件树调和大法...',
  'Hooks 勾魂术...',
  'useEffect 副作用因果...',
  'Redux 中枢天宫...',
  'Zustand 灵台藏识...',
  'CSS-in-JS 画地为牢...',
  'Tailwind 疾风步...',
  'Webpack 热更换血重生...',
  'Vite 按需凝形...',
  'ESBuild 极速神行...',
  'SWC 闪电炼形...',
  'SSR 天地初开...',
  'Hydration 魂归肉身...',
  'Ink 终端墨宝...',
  '虚拟 DOM 镜花水月...',
  '事件冒泡顺流而上...',
  '状态提升登峰造极...',
  '懒加载厚积薄发...',
  '代码分割庖丁解牛...',

  // 护法加密 - 安全之道 (15条)
  'SHA-256 炼心咒...',
  'AES-256 玄冰封印...',
  'RSA 阴阳双钥...',
  'JWT 信物令牌...',
  'OAuth 门派授权...',
  'CSRF 防御结界...',
  'XSS 祛邪过滤...',
  'SQL 注入克星...',
  'PBKDF2 淬炼秘钥...',
  '零知识誓言验证...',
  'HTTPS 金钟罩...',
  '签名验证印玺鉴定...',
  '盐值加密炼丹配方...',
  '双因素认证双重认证...',
  '权限控制天条律令...',

  // 趣味祖师爷 (20条)
  '拜见图灵祖师爷...',
  '冯·诺依曼传道...',
  'Linus 大侠坐镇...',
  '参悟 Rust 生命轮回...',
  '逃离回调地狱轮回...',
  'await 静待天时...',
  '捕获野生 Bug 妖兽...',
  '喂养橡皮鸭灵兽 🦆...',
  '炼丹调参秘术...',
  '0xDEADBEEF 死亡凝视...',
  '递归无限轮回...',
  '闭包封印记忆...',
  'Promise 未来契约...',
  'async 异步神功...',
  'Generator 分身术...',
  'Proxy 替身傀儡...',
  'Reflect 返照镜...',
  'Symbol 独一无二印记...',
  'WeakMap 过眼云烟...',
  'Iterator 周而复始...',

  // 开源江湖 (15条)
  'GitHub 武林大会...',
  'Star 点赞声望...',
  'Fork 拜师学艺...',
  'Pull Request 挑战切磋...',
  'Code Review 武功点评...',
  'Issue 悬赏令...',
  'Merge 收徒入门...',
  'Commit 闭关修炼记录...',
  'Branch 分支独辟蹊径...',
  'Tag 里程碑界碑...',
  'Release 出关发布...',
  'License 门规戒律...',
  'README 入门心法...',
  'Documentation 武学秘籍...',
  'Open Source 广纳贤才...',
];

/**
 * 实用提示信息 - 快捷键和常用命令
 */
export const INFORMATIVE_TIPS = [
  // 快捷键 (10条)
  'Esc - 立即停止当前任务',
  'Shift+Tab - 切换权限模式 (default/auto_edit/plan)',
  'Tab - 智能补全斜杠命令',
  '↑↓ - 浏览输入历史记录',
  '双击 Esc - 快速清空输入框',
  'Ctrl+C - 强制终止程序',
  'Ctrl+D - 优雅退出 Blade',
  'Ctrl+L - 清屏（保留历史）',
  'Ctrl+R - 反向搜索历史',
  'Ctrl+U - 清空当前行',

  // 斜杠命令 (15条)
  '/help - 查看完整帮助文档',
  '/init - 生成 BLADE.md 项目配置',
  '/resume - 恢复历史会话',
  '/compact - 手动压缩上下文（节省 token）',
  '/theme - 切换 UI 主题风格',
  '/config - 查看当前配置',
  '/model - 管理 LLM 模型配置',
  '/permissions - 管理工具权限规则',
  '/mcp - 查看 MCP 服务器状态',
  '/agents - 管理 Subagent 配置',
  '/version - 显示 Blade 版本信息',
  '/clear - 清除对话历史',
  '/export - 导出对话记录',
  '/debug - 开启/关闭调试模式',
  '/benchmark - 性能基准测试',

  // 高级功能 (10条)
  '@ 文件路径 - 附加文件到上下文',
  '@dir/ - 附加整个目录',
  '@file.ts:10-20 - 附加指定行范围',
  'Plan 模式 - 先规划后编码（/plan）',
  'Auto Edit 模式 - 自动批准工具调用',
  'MCP 协议 - 扩展外部工具集成',
  'Subagents - 并行执行子任务',
  'Hooks 系统 - 自定义工具执行流程',
  'Context 压缩 - 自动总结历史对话',
  'Loop 检测 - 防止无限循环',

  // 最佳实践 (10条)
  '提示：使用 /init 让 AI 理解你的项目结构',
  '提示：Plan 模式适合复杂多步骤任务',
  '提示：Auto Edit 可加速重复性操作',
  '提示：@ 引用可提供更精准的上下文',
  '提示：定期 /compact 节省 token 成本',
  '提示：使用 /permissions 控制工具权限',
  '提示：Shift+Tab 快速切换模式',
  '提示：Esc 可随时中断长时间任务',
  '提示：/resume 继续未完成的对话',
  '提示：/export 保存重要对话记录',
];

/**
 * usePhraseCycler Hook
 *
 * @param isActive - 是否激活短语循环（通常在 Agent 处理中时为 true）
 * @param isWaiting - 是否等待用户确认（显示固定等待文本）
 * @returns 当前显示的短语
 */
export function usePhraseCycler(isActive: boolean, isWaiting: boolean): string {
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

    // 随机选择一个短语（首次加载）
    const selectRandomPhrase = () => {
      // 1/6 概率显示实用提示，5/6 概率显示幽默短语
      const showTip = Math.random() < 1 / 6;
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
  }, [isActive, isWaiting]);

  return currentPhrase;
}
