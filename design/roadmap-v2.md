# JIDE 路线图 v2(Router 化:从单 agent 驾驶舱到单机 super agent harness)

> 2026-11-01 制定。输入参照:**Orca**(stablyai,agent 机群编排器)、**DeepSeek Super-agent 设计探索**(Router+Worker/连续实体四件套/实测数据)、**HiFox**(团队任务管理层,语义参照)。
> 前置文档:`business-design.md`(M1–M4 已交付)、`tech-stack.md`。本路线图是 §9 里程碑的**后继**,不推翻既有章节。

## 0. 现状基线(2026-11-01,全部已验证)

已交付:M1 骨架(外挂 pi 子进程 RPC)、M2 IDE 基面、M3 测试闭环(4A–4F)、M4 记忆、W1–W6 工作区模型、**工具桥**(8 领域工具,pi 扩展→HTTP 回环→宿主服务)、**日志回喂**(DevLogPump→steer,只推 busy)、**扩展 UI 请求全链**(协议 v3)、**模型配置**(favorites/default/set_model 即时切换)。83 单测全绿。

对照 super-agent 四件套,我们的天然占位:

| 连续实体组件 | DeepSeek 设计 | JIDE 现状 |
|---|---|---|
| Worker(强模型,独立上下文+工具) | Worker 层 | ✅ 每工作区 pi 子进程 + 工具桥 |
| ①事件驱动 Trigger | 两级过滤(规则粗筛→模型精判) | 🟡 只有粗筛(DevLogPump),缺模型精判 |
| ②投机执行 | 后台静默修复→确认才提交 | 🟡 W5 自动提交+W6 评审门禁是收口半边,缺"后台静默"发起方 |
| ③异步 ReAct Loop | 转后台、中途改向/终止 | ✅ steer/abort + 日志回喂即同哲学 |
| ④存算分离+Watchdog | 云端循环+本地 daemon+监督员 | ❌ 缺 Router 层与 Watchdog |
| Router(轻模型常驻,统一入口) | 任务分派+跨任务上下文 | ❌ **缺,本路线核心** |

## P0 认证闸门(2026-11-01 完成)

- ☑ 用户配置模型(DeepSeek V4.1 Flash,`~/.pi/agent/models.json` provider `cc-switch-deep-seek`)
- ☑ `bun scripts/e2e-pi-rpc.ts` 全链绿:真实模型流式回复 ok / 会话落 JIDE 目录 / rebuild 恢复 2/2 / 进程零残留
- ☑ 模型目录实链:`get_available_models` 实拉返回 1 个模型,UI models.list 可用
- ☑ 工具桥真实执行半链:`scripts/e2e-tools-live.ts`——模型调用 git_diff_files → 桥(token)→ 宿主 gitStatus → 结果回喂模型(见脚本输出)

## P1 单 agent 纵深收口(Router 前把驾驶舱做满,~1 周)

原则:不新增引擎能力,只把"人 ↔ 单 agent"体验做满。抄 Orca 的两个件:

1. **终端操作工具**(Orca CLI-as-API 的等价物):工具桥补 `terminal_read` / `terminal_send`(terminal-manager 已有),agent 可看终端输出、代敲命令。□ agent 能自行 read 底部终端并复现用户报错
2. **外部投递(prefill)**:`askWithContext` 占位补全——终端报错右键问 agent、检查项失败一键转任务。□ 从终端/检查项一键发起,上下文自动带入对话
3. □ 真实模型下打磨:选测耗时、截图回传体积、记忆建议质量(全链实测调参)

## P1.5 daemon 化 + Automations(常驻宿主,完整功能,~2-3 周)

Q3 已拍板:automations 建在 daemon 上。按完整功能开发(不搞最小版——见 2026-11-01 用户铁律),本阶段一次交付:

**A. daemon(常驻宿主,全量)**
- 全部宿主服务进 daemon:AgentHost/Workspace/File/Terminal/Plan/DevServer/Browser/Checks/Review/Memory/Settings/Credential/TestRunner/ModelCatalog/ToolBridge/DevLogPump——它们已是 bindEmitter 解耦形态,整体迁入
- Electrobun 主进程变薄壳:窗口/系统对话框/预览窗留本地,其余 RPC 全量代理到 daemon(契约不变,webview 零改动);事件流经代理回放(lastSeq 补齐机制已备)
- 传输:127.0.0.1 + Bearer token(工具桥同款,已验证的模式);端口/令牌落 `%JIDE_HOME%/daemon/`
- 生命周期:app 启动时 ensure(健康检查→不在则拉起);app 关闭 daemon 常驻;单实例锁;崩溃自动重启;开机自启(设置项)
- 事件日志持久化(daemon 重启可回放;会话本身在 pi 会话文件,天然持久)

**B. Automations(完整功能域)**
- 数据模型:`automations.json`——{id, name, trigger: cron|"daily"|"weekdays"+time|事件触发(test-failed/checks-failed), prompt, modelKey?, 目标(repo→每 run 新 worktree|指定 workspace), enabled, 建议会话复用与否},运行历史(有上限)
- 调度器:daemon 内 cron(5 字段 + daily/weekdays 快捷)分钟级 tick + 事件触发钩子(复用 Trigger 管道)
- 执行:解析目标工作区→建会话(可指定模型)→prompt→settled 后自动 test_run+checks→结果卡进 W6 评审队列
- 管理 UI:WorkflowDock 新「自动化」页签(list/create/edit/enable/run-now/runs 历史)
- □ 验收:关掉 app,每晚定时回归照跑、照提交、评审队列出结果卡;事件触发(测试失败→自动修复任务)全链;app 重开事件无缺口

## P2 Router 层(单机 super agent 核心,~2-3 周)

把"会话"降级为系统内部细节,人只对 Router 说话。DeepSeek 数据:Router+Worker p95=15.7min vs 单 Session p95=29.5min;代价缓存 token +37%。

1. **Router 会话**:常驻轻模型会话(复用 pi 子进程缝,模型可独立于 Worker 配置),唯一对话入口;职责=任务理解/拆分/分派/汇总。pi 底层件已就位:`new_session(parentSession)` / fork / get_tree
2. **Worker 池**:每任务一个 Worker 会话(可不同模型,模型配置已支持);并发上限(默认 3,可配);Worker 用现有工具桥按 workspaceId 路由——桥无需改
3. **Worker 订阅通道**(DeepSeek 订阅机制):评论/日志/测试结果直推 Worker 不绕 Router——已有两根管子:日志回喂(扩到任意 workspace 事件源)+ extension_ui_request
4. **Trigger 模型精判**:两级过滤补全——规则粗筛(现有 regex 泵)命中后,轻模型判断"值得打断谁"(推 Worker steer / 仅记录 / 忽略)。□ dev server 报错精准推给该任务的 Worker,不误扰空闲会话
5. **投机执行**:Router 收到低风险任务→后台 Worker 静默跑"复现+修复+自测"→检查项全绿才生成提交→W6 评审队列人工收口。**W6 门禁是我们对 DeepSeek 未解难题(审批介入)的先发答案**
6. **Watchdog**:独立轻检查(非 Worker 自觉):检测无效循环(同工具同参数重复 N 次/无 settled 长时间挂起)→ Router 汇报→人裁决。□ 注入一个死循环任务,Watchdog 5 分钟内告警

验收(P2 整体):□ 一个自然语言目标经 Router 拆成 ≤3 个子任务,分派并发 Worker,全部完成后汇总报告,全程人只看 Router 对话;□ 任意 Worker 可中断/改向不影响兄弟任务;□ 全程事件可在评审队列追溯

## P3 Fleet 与任务域(Orca 件 × HiFox 语义,~2 周)

1. **Fan-out 竞赛**(Orca 招牌):同一 prompt 播 N 个隔离 worktree(可混配模型)→ 并排对比(各 Worker 的 test/检查项得分 + diff 视图)→ 人选优,落选分支一键清理。**判优已定(Q2)= 检查项自动打分 + 人工终审**。□ 一拖三修复同一 bug,面板并列三份"测试通过率+检查项+diff",选一合入
2. **Worktree 血缘与合并流**:child/stacked worktree(Orca lineage 语义),合并走评审队列门禁(已有 B9)
3. **任务卡视图**(HiFox 语义本地化):任务→Worker→验证→人收 的看板;数据源=orchestration 数据(pi session tree + plan + 评审队列),不引入团队协作
4. **Router 化 automations**:P1.5 的 automations 触发器从"直接建会话"升级为"提交给 Router 拆解分派"(定时/事件 → Router → Worker 池),与 P2 无缝衔接

## P4 规模化形态(远期,不承诺时间)

- ~~Daemon 化~~ **已前移至 P1.5(Q3 拍板)**
- **Remote runtime / 手机 thin client**(Orca mobile,E2EE):daemon 化之后的自然延伸
- **长期记忆**(DeepSeek 未解难题):跨周/月任务上下文恢复,记忆域从"规范沉淀"向"任务经历"扩展,git 即同步(维持非目标:账号云同步)

## 非照搬清单(边界,并入 business-design §8)

| 不做 | 理由 |
|---|---|
| 30+ CLI 通吃 / PTY 抓屏编排(Orca 路线) | 垂直产品吃透 pi 一家;结构化 RPC 优于抓屏启发式 |
| 团队协作/IM 入口层(HiFox 域) | 单机定位;任务语义可参照,产品形态不做 |
| 账号体系/云端同步 | 维持既有非目标 |
| 插件市场 | 维持既有非目标 |

## 已定架构决策(继承)

- 引擎:外挂 pi 子进程 + 工具桥(B 决策 2026-11-01),Router/Worker 全部长在现有缝上(AgentEngine/PiRpcClient/桥/workspaceId 路由),不引第二引擎
- 人工门禁:一切自动提交/投机执行结果经 W6 评审队列,人始终是合并的唯一关卡
- 成本意识:Router+Worker 接受 DeepSeek 实测的缓存 +37% 代价;Worker 默认并发 3;Router 用轻模型

## 已拍板(2026-11-01,用户)

| # | 问题 | 决定 |
|---|---|---|
| Q1 | Router 形态 | **常驻轻模型会话**(DeepSeek 验证过;pi 多会话地基已在) |
| Q2 | Fan-out 判优 | **检查项自动打分 + 人工终审** |
| Q3 | Automations 宿主 cron vs daemon | **建在 daemon 上**——daemon 化提前为 P1.5 |
| Q4 | Router/Worker 模型 | 用户已配置 DeepSeek V4.1 Flash(`cc-switch-deep-seek`);Router 可用同库,后续按需增配轻模型 |
