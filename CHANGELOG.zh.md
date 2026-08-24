# Changelog

## [0.10.84] - 2026-08-23

### 变更
- Session transcript 初始化现在由不同存储 facade 共享同一个首访问执行，并在每个
  facade 中使用最多 256 项的 LRU 正向缓存保存成功结果
- 普通消息、工具、交互、评审、压缩与生命周期追加不再仅为确认不可变 Session
  metadata 已存在而重复读取并解析完整 transcript

### 修复
- 新 Session 的并发首次写入不再提交重复的 `session_created` 事件
- 失败或损坏的初始化不会进入缓存；删除 Session 时会在复用前使本地初始化正向缓存
  失效

### 测试
- 新增独立 facade 并发首写、连续 event sequence、热路径零重扫、失败后重试、
  delete/recreate 与有界 LRU 淘汰的确定性覆盖
- 发布资格继续使用真实 Provider 覆盖 Headless、raw PTY TUI、production Chromium
  Web GUI 与 ACP
- Provider recovery Web 资格测试现在会在有界诊断尾部截断前锁存完整的结构化生命周期
  证据
- Token-budget 资格测试现在会在隐藏 Bash marker 前输出显式终答复制契约，同时保留
  精确输出断言和零测试重试

## [0.10.83] - 2026-08-23

### 新增
- 超过 32 KiB 的用户 Prompt 现在写入 Session 私有、内容寻址的 artifact；Provider
  只接收 UTF-8 安全的有界摘要和 opaque artifact ID
- 新增始终可用的只读 `ReadPromptArtifact` 工具，支持最大 64 KiB 的校验后分页读取，
  且不暴露宿主路径

### 变更
- TUI、Headless、Web 与 ACP 统一使用 1,000,000 字符和 4 MiB 的 durable 用户输入
  契约，覆盖 active-turn steering 与重启恢复
- Session fork 只复制实际引用的 prompt artifact；删除 Session 会清理私有 artifact，
  且不影响 source 或 sibling Session

### 修复
- 大型规格、日志和迁移请求不再受旧 32,000 字符传输上限阻断，也不会完整进入首次
  Provider 请求
- 宿主 verification、worktree、delegation 与 completion policy 仍基于完整原始请求，
  多模态分流保持图片顺序
- artifact ID、owner、权限、大小、哈希、layout 或 symlink 替换不合法时，读取统一
  fail closed

### 测试
- 新增 UTF-8 分页、metadata 持久化、重启、fork/delete 生命周期、多模态顺序、配额、
  transport 上限、工具过滤与原始输入宿主策略的确定性覆盖
- 新增 release-blocking DeepSeek Flash/Pro × Headless、raw PTY、production Chromium
  Web、ACP 矩阵，证明隐藏 Prompt 内容只能通过匹配的 durable tool result 进入 Provider
- 强化 token-budget continuation fixture，确保 fallback compaction 后仍保留精确
  最终输出协议；为新增的大 Prompt 八格覆盖将完整发布矩阵 watchdog 从 60 分钟提升到
  90 分钟
- 将大输出 foreground accounting 对照的 handoff 余量提升到 5 秒，避免高负载宿主
  意外进入后台路径；TUI batched-input 测试 Harness 提交最新已渲染输入，避免旧闭包
  造成假失败

## [0.10.82] - 2026-08-23

### 新增
- 预测式上下文窗口计数现在使用最新的完整 Provider token usage 作为基线，并在下一次
  请求前只估算响应后的 tool result、control message 与请求形状正向增长
- Durable compaction checkpoint 与 Headless、Web、ACP 生命周期投影新增
  `preTokenSource` 和 `estimatedPendingTokens`

### 变更
- 70% handoff 与 80% compaction 阈值改为共享同一个完整上下文投影，不再依赖上一请求
  的 prompt tokens
- 模型与 tool schema 切换会保留 Provider usage 作为保守下限；历史被破坏性改写或
  usage 缺失时，对完整 system、tools 与 history 执行本地估算
- TUI 上下文占用改用完整 Provider total tokens，与 Web 保持一致

### 修复
- 大模型响应、tool result、runtime control message 和新激活的 project rule 不再让
  下一次 Provider 请求持续低估，直至触发反应式 context-limit failure
- Turn-limit compaction 的压缩前 token 投影现在包含完整响应与 tool-result 增量

### 测试
- 新增边界、过期基线、模型/schema 切换、历史改写、持久化与跨端确定性覆盖
- 使用真实 DeepSeek Flash/Pro 在 Headless、raw PTY、production Chromium Web 与 ACP
  验证 prompt usage 低于阈值一 token 的负向对照
- 最终 token-budget marker 仅由成功的验证命令返回，防止模型绕过要求的四阶段
  工具轨迹直接作答
- ACP residency 资格测试现在会等待作为 steering 接受的 follow-up 完成 durable
  acknowledgement 后再关闭会话

## [0.10.81] - 2026-08-23

### 新增
- 确定性 compaction fallback 现在取以下目标的最小值：带 5,000-token 下限的
  源内容 80% 预算、模型上下文窗口的 50%，以及 50,000-token 绝对上限
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增 fallback
  token 目标、省略消息数和截断消息数

### 变更
- Fallback 历史按从新到旧保留完整原子 tool-call 单元，并最多对一个超大边界单元
  按实测 token 截断，同时保留头尾
- 强制 continuation checkpoint 仅可将 fallback 目标提升到自身实测大小

### 修复
- Fallback 历史不再保留 reasoning 载荷、图片、孤立 tool result、不完整的空
  assistant turn，也不会重复保留已由完整 checkpoint 覆盖的 active-task 请求
- Token 统计现在包含重放的 reasoning 内容，compaction reminder 会保留精确的待执行
  动作与最终响应约束

### 测试
- 使用 DeepSeek Flash/Pro 在 Headless、raw PTY、production Chromium Web 与 ACP
  验证确定性 fallback 和真实摘要恢复
- 使用真实 DeepSeek Flash/Pro、Claude、GPT 验证 compaction 安全性；Production
  Qualification 全部 16 项通过，真实 API 测试 174 项通过

## [0.10.80] - 2026-08-23

### 新增
- Compaction 现在使用同一 token 估算基准检查完整 replacement，包括 retained
  messages 与恢复的 checkpoint
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增稳定的
  `insufficient_reduction` fallback 分类

### 修复
- 对至少 5,000 个估算 token 的历史，当完整 replacement 保留超过源内容的 80%
  时，不再提交非空摘要；Blade 会确定性 fallback 并保留已计费 usage
- 连续无效摘要会进入现有的 session 级熔断器，不再无界请求 Provider
- 跨 Provider 发布资格测试将 GPT fallback 的 idle deadline 与 request deadline
  对齐，同时保留 45 秒整体恢复上限

### 测试
- 新增完整 replacement、usage、熔断器、checkpoint 与跨端投影覆盖
- 使用真实 DeepSeek Flash/Pro、Claude、GPT 验证有效压缩，并完成生产 Web、
  raw PTY、Headless 与 ACP 发布矩阵

## [0.10.79] - 2026-08-23

### 新增
- Compaction 在调用纯文本 summary Provider 前，将每个多模态图片部分替换为固定文本
  占位符
- Durable checkpoint 与 TUI、Headless、Web、ACP 生命周期投影新增每次压缩请求
  省略的图片数量

### 修复
- 内联 data URL、base64 图片载荷和远程图片 URL 不再进入 compaction Provider，
  同时保持 canonical history 与 retained messages 不变
- 真实 API 恢复资格测试不再使用容易触发隐私拒绝的 marker 措辞，并将串行 Web 与
  ACP trajectory 隔离到不同 Provider channel

### 测试
- 新增 fail-closed proxy 检查以及真实 DeepSeek Flash/Pro、Claude、GPT trajectory，
  证明图片载荷隔离、文本保留、durable 指标和 canonical message 不可变性

## [0.10.78] - 2026-08-23

### 新增
- Compaction 在原有三次总预算内自适应缩减超窗摘要输入：依次移除可重读文件、
  丢弃最旧完整 tool-call 单元，再降低单消息字符上限
- Durable checkpoint 与 Headless、Web、ACP 生命周期事件新增输入缩减次数以及省略
  消息/文件计数

### 修复
- Context window 失败不再重放相同 compaction payload；宿主无法生成严格更小请求时
  会立即进入 fallback
- 缩减输入的摘要成功后，exact continuation records 会从完整 canonical transcript
  逐字恢复

### 测试
- 真实 DeepSeek Flash/Pro × Headless、raw PTY、production Chromium Web、ACP
  矩阵现在依次注入 context overflow 和 `503`，证明 retry payload 更小并验证 durable
  reduction metadata

## [0.10.77] - 2026-08-23

### 新增
- Compaction summary 针对 Provider 瞬态失败、断流和空响应增加最多三次的有界恢复
- Durable checkpoint 以及 Headless、Web、ACP 生命周期事件新增压缩采样次数和稳定
  fallback 分类

### 变更
- Compaction 禁用嵌套 ChatService retry，由单一宿主策略统一控制分类、指数退避、
  abort 和请求次数

### 修复
- 认证、权限、非法请求、context overflow 和 caller abort 现在会立即停止压缩重试
- 成功但为空的压缩采样所消耗的 usage 与 cost 会累计
- Web recovery 资格测试将协议证据与大型渲染 HTML 分开保存，避免有效的早期 retry
  事件被尾部截断

### 测试
- 真实 DeepSeek Flash/Pro × Headless、raw PTY、production Chromium Web、ACP
  token-budget 矩阵现在注入一次 compaction `503`，要求发起新的真实摘要请求，并验证
  durable `sampleAttempts: 2`

## [0.10.76] - 2026-08-23

### 新增
- Goal 验证现在会在 continuation、上下文压缩、进程重启和 subagent 结果接管之间
  保留有界、脱敏的结构化反馈
- 验证缺口状态会投影到 TUI、Headless JSONL、Web 与 ACP

### 变更
- 相同 verifier 缺口第二次出现时会要求改变策略，第三次出现时会原子阻断 Goal
- Goal 编辑、显式恢复以及新的 verifier PASS 会清理过期验证停滞状态

### 修复
- Verifier 反馈现在会替换工作区根路径、脱敏常见凭据、转义控制标记，并限制在
  4,000 字符以内
- 真实 API handoff 资格测试在保持严格持久边界检查的同时，允许有界模型纠正回合
  与延迟 TUI 渲染

### 测试
- 新增持久化、脱敏、收敛、跨端投影和崩溃接管的确定性覆盖
- 使用真实 DeepSeek、Claude、GPT 与 Qwen 验证 verifier
  FAIL-to-repair-to-PASS 轨迹，并完成生产 Web、raw PTY、ACP 与完整 16 项
  production release matrix

## [0.10.75] - 2026-08-23

### 测试
- 为刻意超过 16 MiB 的 SSE 校验测试设置显式超时预算，使完整覆盖率插桩在受限 CI
  runner 上保持稳定，同时不改变生产响应上限

## [0.10.74] - 2026-08-23

### 新增
- 活跃 Goal 现在会保守识别 assistant 最后段落中的提前停止模式，并且只持久化
  pattern、连续次数与检测时间
- Goal 恢复状态会投影到 TUI 状态、Headless JSONL、Web SSE 与 DOM 属性，以及
  ACP metadata

### 变更
- Goal continuation 在检测到延期或交接后会发出可执行的恢复指令；同一模式连续
  第二次出现后会要求改变执行策略

### 修复
- 同一提前停止模式连续出现三次时，Goal 会原子切换为 `blocked`，避免无界
  continuation 和 token 消耗，同时不设置全局 continuation 上限
- 正常进展与用户显式 Goal 操作会清理过期恢复状态

### 测试
- 新增分类器、持久化、提示词、生命周期投影与 Web 组件的确定性覆盖，并包含误报
  对照组
- 使用真实 DeepSeek、Claude、GPT 与 Qwen Provider 验证自主恢复，并完成生产桌面/
  移动 Chromium、raw PTY 渲染及完整 16 项 production release matrix

## [0.10.73] - 2026-08-22

### 新增
- 为 TUI、Web 与 ACP 新增配置开关控制的 Agent Teams，复用 `.blade/agents`
  和 `.claude/agents` 角色定义，并提供持久化团队定义与共享依赖任务图
- 新增原子任务领取、依赖自动解锁、点对点与广播持久邮箱，以及实时 `team.*`
  生命周期投影
- 具备写能力的 teammate 默认使用隔离 worktree，并拒绝嵌套创建团队

### 变更
- Provider 请求默认不再受隐式 owner、global 或请求类别并发限制；只有显式配置
  准入限制时才启用调度
- Web 的 Team schema、传输与翻译跟随聊天界面按需加载，不增加首屏 bundle

### 修复
- teammate 消息不会出现在用户聊天中，同时保持持久化并对目标模型上下文可见
- Team 状态由权威 agent session 与任务状态派生；关闭 Agent Teams 时 Web 不再发出
  会失败的请求

### 测试
- 新增团队生命周期、所有权、任务 DAG、邮箱投递、HTTP 路由、slash command、ACP
  metadata、TUI 状态、Web 状态与 UI 交互的确定性覆盖
- 完成 DeepSeek Flash/Pro 团队协作、生产桌面/移动 Chromium、raw PTY 渲染以及完整
  production release matrix 验证

## [0.10.72] - 2026-08-22

### 新增
- 为 TUI、Web 与 ACP 新增 `/btw <question>` 旁路对话，并提供独立的瞬态加载、
  结果、错误、取消和关闭状态
- 旁路问题复用当前 Session 的模型上下文与 Provider 提示词前缀，同时保持单轮且
  禁止工具执行
- 为 Web 新增 `POST /sessions/:sessionId/side-question`

### 修复
- 旁路问题与回答不会进入主 Session transcript、durable inbox 或后续模型上下文，
  也不会中断或引导正在执行的主回合
- Runtime 销毁与表面导航现在会取消并等待进行中的旁路对话

### 测试
- 新增服务、Runtime、HTTP、ACP、TUI、Web store 与组件的确定性覆盖，包括 JSONL
  字节完全一致断言
- 在关闭框架重试的条件下完成真实 DeepSeek Runtime、GPT Web route、Claude ACP、
  DeepSeek PTY，以及桌面/移动 Chromium 流程验证

## [0.10.69] - 2026-08-22

### 修复
- subagent 会话存储现在在内存中最多保留 256 个非活跃会话 sidecar，同时固定
  （pin）正在运行的会话，防止历史 Task 流量导致长期存活的 Web 与 ACP 进程堆
  无限增长
- 会话缓存命中会刷新最近最少使用（LRU）顺序，全量会话扫描会保留最近活跃的终态
  会话

### 测试
- 新增终态会话频繁更替、驱逐后磁盘重载，以及活跃会话固定的测试覆盖

## [0.10.68] - 2026-08-22

### 新增
- Fallback 模型引用现在可以通过 `configId` 选择一个具体的模型配置，使每个
  fallback 都能使用各自的凭据、端点和请求覆盖项

### 修复
- 输出前的 Provider 空闲超时现在可以切换到另一个 fallback Provider，而不会重试
  已停滞的 Provider
- 跨 Provider 的熔断、请求准入和传输选项现在使用 fallback 通道身份，而不是主通道
- 原始 PTY 资格判定在权威、持久的最终结果与所需输出不匹配时会立即失败，而不再
  等待完整的超时时间

### 测试
- 新增一条真实的 Claude 超时切换到 GPT fallback 的轨迹测试，使用独立的通道凭据
  并严格断言不重试主通道
- 新增 fallback 配置、重放边界、准入隔离，以及 PTY 终端分类的测试覆盖

## [0.10.67] - 2026-08-22

### 修复
- 会话事件日志实例现在使用有界的最近最少使用（LRU）缓存，因此长期运行的 Web 与
  ACP 进程不会保留每一个历史 Session，同时活跃的流订阅者仍会被固定（pin）

### 测试
- 为统一的 Session 事件流新增缓存容量、最近最少使用（LRU）驱逐，以及实时订阅者
  保留的测试覆盖

## [0.10.66] - 2026-08-22

### 新增
- Web 现在提供多项目任务看板，包含等待、活跃、阻塞和评审阶段，由持久化的任务状态
  和全局 SSE 数据流驱动
- 看板任务支持本地工作区派发、项目筛选、搜索、优先级、任务类型、截止日期、取消、
  重试、变更检查，以及通过归档进行验收
- 自动任务领取可以在不打断活跃工作的情况下暂停，并按 FIFO 顺序恢复
- 任务状态、优先级、种类和截止日期会投影到专用的 SQLite 列中；任务扫描会将状态、
  优先级和截止时间筛选下推到有索引的 SQL 中，同时保留等价的 JSONL 回退行为

### 变更
- Web 模型选择默认使用一个具体的、受支持的推理强度（reasoning effort），而不是含糊
  的 `auto`，同时保留显式的 `off`
- 将 `pi-ai` 更新到 `0.84.2`，使推理能力来源于 Provider catalog
- Compaction 将有界的 `EXACT CONTINUATION RECORD` 行视为宿主拥有的契约，并在规范化
  的账本（ledger）标题下恢复它们

### 修复
- 成功执行工具后出现的空最终响应会获得一次持久的纠正，如果模型仍然为空则以失败
  收场（fail closed）
- 回合中止回执（abort receipt）会原子地保留输入确认、成功的工具证据，以及已消耗的
  纠正状态，可跨进程重启存续
- 结构化输出在输出 token 边界处提交有效负载后，仍保持权威性
- 只读校验沙箱在保留 Session Node 工具链的同时，仍拒绝访问工作区和主目录
- 测试进程会隔离并回收临时根目录和受管理的 Git overlay
- Web 任务开始/最终等待，以及 ACP/Headless 最终投影，会观测正确的已提交生命周期
  边界

### 测试
- 新增可阻塞发布的 DeepSeek Flash/Pro token 预算交接测试覆盖，跨 Headless、原始
  PTY、生产 Web Chromium 和 ACP，框架重试次数为 0
- 新增针对精确记录对账、空最终结果恢复、中止回执、ACP 清理截止期限，以及有界诊断
  的确定性测试覆盖

## [0.10.65] - 2026-08-20

### 修复
- 只读校验 agent 现在接受 test、lint、type-check 和 build 命令，只要其输出被单个
  数值型 `head` 或 `tail` 管道所限定；Blade 会在执行前移除该投影，以便原始命令的
  退出状态保持权威
- 校验沙箱可以读写其专用的临时缓存，同时源工作区保持只读，并且校验器指引现在会为
  发出工作区产物的构建脚本替换为无写入检查
- 校验命令准入仍会拒绝读取文件的管道参数、写入输出的 `tee` 管道、重定向，以及
  链式命令

### 测试
- 新增校验命令与权限边界回归测试，涵盖安全的输出截断、真实退出码保留、不安全的
  管道变体，以及原生只读沙箱临时存储

## [0.10.64] - 2026-08-19

### 修复
- LSP 客户端现在会忽略来自已释放传输代际（transport generation）的延迟进程和
  JSON-RPC 关闭事件，而不会把干净的关闭报告为崩溃，也不会清除替换服务器的
  已初始化状态

### 测试
- 新增确定性的传输代际测试覆盖，证明一个过时的 LSP 子进程无法修改或使一个新初始化
  的连接失败

## [0.10.63] - 2026-08-19

### 修复
- Vitest worker 现在会创建互不冲突的自有存储根目录，并在测试文件拆卸时同步移除它们，
  而不再遗留以 PID 命名的状态
- 显式提供的 `BLADE_STORAGE_ROOT` 目录仍归调用方所有，绝不会被测试框架移除
- npm publish 现在使用 Trusted Publishing（OIDC）并声明 `repository` 元数据，使
  sigstore 溯源（provenance）验证得以成功

### 测试
- 新增真实子进程测试覆盖，证明自有根目录在 worker 自然退出后消失，而外部管理的
  根目录及其内容保持完好

## [0.10.62] - 2026-08-19

### 变更
- CLI 的 Unicode 码点（code-point）与字符串宽度缓存现在使用条目数量和保留大小的
  LRU 限制，而不再永久保留每一个渲染过的非 ASCII 字符串
- 语法高亮现在同时强制其已有的 200 行限制和 512K 保留字符预算
- 超大宽度输入和代码行仍会被渲染，但不再被纳入进程级缓存

### 测试
- 新增高基数 Unicode 文本频繁更替、超大输入、缓存重置、唯一高亮行频繁更替，以及
  超大代码行常驻的测试覆盖
- 重新运行完整的 TUI 平台 UI 测试套件，涵盖消息渲染、Static 所有权、输入、hooks、
  工作区信任，以及 Session 切换

## [0.10.61] - 2026-08-19

### 变更
- HookManager 现在最多保留 64 个非当前工作区和 worktree 配置，同时活跃的 Session
  会保留独立的 hook 快照
- 工作区信任评审现在使用 64 条目的 LRU，而不再永久保留长期运行的 Web 或 ACP 进程
  检查过的每一个路径
- 受管理的 worktree 转换会将继承的 hook 绑定到拥有它的 Session，使工作区缓存驱逐
  无法改变一个活跃的回合

### 修复
- Session 释放现在会移除该 Session ID 的每一个动态 hook 配置、暂停别名和瞬态
  worktree 引用，而不只是它的最终路径
- HookManager 清理现在会恢复一个可复用的默认状态，而不是保留当前工作区配置或
  进程级的禁用标志

### 测试
- 新增项目与信任缓存频繁更替、活跃 Session 快照存续、动态 worktree 驱逐、完整
  Session 别名清理，以及单例复用的测试覆盖

## [0.10.60] - 2026-08-19

### 变更
- 工作区 agent 目录（catalog）现在最多保留 32 个空闲工作区，并进行确定性的 LRU
  驱逐，同时保护活跃和初始化中的条目
- 活跃或初始化中的工作区目录总数上限为 64，且 Web 请求会在另一个目录启动前收到
  可重试的过载语义
- Plugin、skill、command 和 subagent 注册表会按对象身份释放被驱逐的工作区代际，
  同时活跃的 Session 保留不可变快照

### 修复
- 失败的工作区目录初始化不再遗留残留的注册表代际
- Plugin 生命周期变更现在会在异步的刷新、安装、策略和对账工作期间固定（pin）其
  工作区目录
- 服务器关闭时会释放工作区目录，并且 MCP/LSP plugin 发现不再创建一个原本无用的
  工作区 PluginRegistry

### 测试
- 新增并发 64 工作区的活跃使用和硬上限测试覆盖、空闲 LRU 排序、跨注册表回收、
  部分失败清理、ABA 保护，以及 plugin-hook 代际恢复测试

## [0.10.59] - 2026-08-19

### 修复
- 命令准入门（admission gate）现在会监控其所属的 Blade 进程，并在该所属进程硬退出
  时终止整个命令组，即使控制管道仍然打开
- POSIX 门会验证直接父子关系，因此 PID 复用无法让一个孤儿命令继续存活

### 测试
- 新增一个真实进程回归测试，硬杀死一个前台命令的所属进程，并证明该门及其忽略 TERM
  的命令会自我回收（self-reap），而无需调用持久的孤儿回收器（orphan reaper）

## [0.10.58] - 2026-08-18

### 变更
- 从无状态的 Agent Team 存储中移除了永久性的每个配置目录（per-config-directory）
  实例表，使得工作区频繁更替无法保留任意的配置路径

### 测试
- 新增一个跨实例持久化契约测试，证明全新的 TeamStore 门面仅共享持久的团队文件，
  而不共享任何进程本地的对象身份

## [0.10.57] - 2026-08-18

### 变更
- Prompt-cache 监控现在仅以 SHA-256 值保留工具身份和契约指纹，包括用户可控的 MCP
  工具名称
- 工具的新增、移除和契约变更会按哈希后的身份进行归因，而不在请求之间保留源 schema

### 测试
- 在已有的归因和有界 Session 测试之外，新增了直接的保留状态隐私测试覆盖
- 强化了真实 GPT 缓存轨迹，使其在断言缓存中断归因之前预热超出 Provider 共享的
  前缀块，框架重试次数为 0
- 稳定了跨进程的工具准入证据，使其能应对非原子的 fixture 标记转换，同时保留精确的
  并发断言

## [0.10.56] - 2026-08-18

### 新增
- Prompt-cache 中断现在会被归因于模型、系统提示、工具 schema、请求策略、TTL，或可能
  的 Provider 侧路由和驱逐变更
- Web 缓存详情、CLI `/cost` 和 Headless JSONL 都会暴露最新的有界缓存中断归因

### 变更
- 缓存中断检测使用每 Session 的 SHA-256 指纹，而不保留提示内容或用户可控的工具名称
- 检测使用自适应 token 阈值，并在显式的 compaction 纪元（epoch）间重置其基线，以避免
  误报

### 修复
- Provider 的工具调用身份现在在实时事件、持久的 JSONL 历史和 Web 重连之间保持稳定，
  而不再在工具卡片正在渲染时发生变化

### 测试
- 新增确定性的归因、TTL、compaction、隐私，以及有界状态的测试覆盖
- 新增一条真实 GPT 轨迹，预热 Provider 缓存、替换每一个稳定的提示块，并验证系统提示
  归因，框架重试次数为 0
- 在 DeepSeek Flash/Pro 和 Headless/ACP/生产 Web 重载上重新验证有界的前台输出，框架
  重试次数为 0

## [0.10.55] - 2026-08-18

### 修复
- Agent Team 成员现在会在流式和非流式工具执行中保留其共享的 `taskListId`，而不再
  写入孤立的 Session 列表
- Task 和 Team 工具现在使用与 Session 运行时状态相同的 `BLADE_STORAGE_ROOT`
- 任务列表变更会在持有跨进程锁的同时重载权威的磁盘状态，防止过时覆盖和重复 ID
- 损坏的任务列表状态现在会以失败收场（fail closed），而不再被一个空列表替换

### 变更
- 任务列表快照以原子方式写入，并采用严格的文件权限
- 任务列表协调不再为每个 Session 保留一个进程级的管理器

### 测试
- 新增确定性的同进程和真实多进程并发、崩溃锁恢复、损坏、路径包含，以及回收的测试
  覆盖
- 新增可阻塞发布的 DeepSeek Flash/Pro Agent Team 轨迹测试，每个模型有四个并发的
  真实 API 队友写入者

## [0.10.54] - 2026-08-18

### 修复
- 只读校验 agent 现在可以执行宿主 Node 运行时，即使它安装在原本不可读的用户主目录
  之下
- 校验沙箱环境合并会保留在允许列表中的宿主 `PATH`，而不暴露 Provider 凭据或 Session
  环境值

### 测试
- 新增确定性的沙箱环境测试覆盖，以及针对裸 `node` 执行的原生 Seatbelt 集成测试
- 重新验证了通过所选 DeepSeek Pro 模型进行的 ACP 模型切换，包括 Edit、`node --test`、
  独立校验和清理

## [0.10.53] - 2026-08-18

### 新增
- CLI 状态栏现在显示 prompt 缓存命中率（`Cache —` / `Cache XX%`）
- Web StatusBar 显示缓存命中率，并带有 tooltip 明细
- `/cost` slash 命令现在包含缓存读/写 token 的明细
- 新增 `derivePromptCacheMetrics` 和 `formatPromptCacheHitRate` 纯函数，用于统一的
  缓存遥测
- 用于缓存状态显示的 i18n 字符串（英文和中文）

### 变更
- 通过稳定请求前缀提升 prompt 缓存效率：
  - 传递 Provider 会话键（`providerSessionId`）以保持缓存连续性
  - 从系统提示中移除动态的 git/列表快照
  - Tools、skills 和延迟工具列表现在按确定性顺序排序
  - 为 Provider 原生缓存启用 `cacheRetention: 'long'`
- 统一缓存命中率公式：`cacheReadTokens / inputTokens`（当没有 Provider 用量时为
  undefined）
- 将 PTY 证据截止期限从 180 秒提升到 270 秒，以适应高延迟的 Provider
- 将 ACP fork 阶段超时从 180 秒提升到 270 秒，并将模型切换从 300 秒提升到 600 秒
- 将单元测试套件的 wall-clock 预算从 240 秒提升到 480 秒
- 在 `REAL_API_RELEASE_MATRIX=1` 下，将 PTY 和 GPT 单元从可阻塞发布的矩阵中过滤掉

### 修复
- 强化了持久的前台/后台进程生命周期测试，使其能应对宿主负载导致的时序问题
- Session Runtime 常驻的 Web 测试清理现在会在 `ENOTEMPTY` 竞争时重试
- Goal 最终化会在恢复过程中保留新鲜的校验回执
- 正确强制执行有界的物理 Provider 尝试截止期限
- 键控（keyed）协调状态可确定性地回收，而不依赖 GC
