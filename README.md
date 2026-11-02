# JIDE

自测闭环优先的轻量 Agentic IDE —— 面向 web 开发:可看文件、可启动项目并让 AI 实时看日志、可测前端/后端/整体业务、有记忆。

外挂 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 引擎(每会话一个 `pi --mode rpc` 子进程,复用你自己的 `~/.pi` 认证/模型/skills),JIDE 只做垂直驾驶舱:测试闭环、检查项门禁、记忆系统、日志回喂、Worker 编排与竞赛。

## 特性

- **测试闭环**:dev server 管理(三模式就绪探测)/ HTTP 探测 / 浏览器自动化(点击+截图+录屏)/ 智能选测(git diff 映射关联用例)/ 检查项(验证沉淀为项目资产,可复验)
- **三种运行档**:Agent 自测 → 人侧运行+内嵌预览 → CDP 后门
- **记忆系统**:建议卡片(不静默写入,采纳/忽略/改后采纳)、三级注入(项目/用户/会话,预算内)、整理合并可回退、AGENTS.md 只读边界
- **工作区模型(W1-W6)**:项目信任门 → git worktree 隔离 → 上下文原子切换 → 计划步骤自动提交(仅隔离区)→ 评审队列人工门禁
- **编排(P2)**:当前对话即 Router —— `spawn_worker`(独立会话+隔离工作区,并发池)、投机执行(静默修复,验证全绿才提交进评审队列)、日志两级过滤(规则粗筛 → 模型精判)、Watchdog(超时/无效循环)
- **竞赛(P3)**:同一任务书一拖 N(逐路可配模型),隔离 worktree 并行执行,自动评分(测试+检查项),人工选优合入主线
- **自动化**:定时(cron/每日/工作日)与事件触发(测试失败/检查项失败)→ 挂机跑 → 评审队列收口
- **daemon 随 app 退出自动回收**(进程树级 taskkill);设置「关闭窗口驻留后台」可切换为托盘常驻(agent 与定时自动化继续跑,托盘可恢复/退出)
- **模型无关**:模型目录来自你自己的 pi 配置,对话内即时切换,常用列表/默认模型/Router 模型可配

## 架构

```
┌─ JIDE 主进程(Electron 薄壳:窗口 + IPC 代理)─────────┐
│   UI(React 19 + Zustand + Tailwind v4)               │
└─────────────┬────────────────────────────────────────┘
              │ Electron IPC(preload 桥)/ 127.0.0.1 HTTP+WS(token)
┌─────────────▼────────────────────────────────────────┐
│  JIDE daemon(宿主服务;随 app 退出自动回收)          │
│  = 同一 electron 二进制以 ELECTRON_RUN_AS_NODE 运行    │
│    AgentHost ── 每会话 spawn ──► pi --mode rpc 子进程 │
│    ToolBridgeServer ◄── HTTP 回环 ── jide-* 扩展      │
│    (10 个领域工具:dev_server/test_run/browser/…)     │
│    DevLogPump / 自动化 / 竞赛 / 评审队列 / 记忆        │
└──────────────────────────────────────────────────────┘
```

协议契约在 [`packages/contracts`](packages/contracts):类型化、版本协商(app.hello)、seq 事件日志可回放。daemon 代码不依赖 Bun API(经 `src/runtime.ts` 适配层),同一份源码可跑 Node(生产)与 Bun(bun test,开发)。

## 环境要求

- Windows 10/11(macOS 理论可跑,未验证)
- [Bun](https://bun.sh) ≥ 1.3(仅开发/测试用;运行时零外部依赖,daemon 由应用自带的 Electron 二进制执行)
- [pi CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):`npm i -g @earendil-works/pi-coding-agent` 或 pi-node 独立安装,并在 pi 内完成模型认证(写入 `~/.pi`)

## 快速开始

```bash
git clone https://github.com/MirJiang/jide.git
cd jide && bun install

bun run dev            # vite dev + 桌面壳(daemon 首启自动拉起)
```

启动后:标题栏「项目」→ 打开一个 git 仓库 → 信任 → 开始对话。让 agent 改完代码,它会自己 `test_run` → `checks` → 走评审队列等你通过。

## 开发

```bash
bun test               # 全量单测(无网络)
bun run typecheck      # contracts 类型检查
bun run dev            # 前端 HMR 开发流(vite + electron)
```

构建与打包:

```bash
cd apps/desktop
bun run build          # vite 前端 + daemon bundle(Node) + electron 壳 + NSIS 安装包
bun run package:dir    # 仅出 win-unpacked 目录(冒烟)
```

E2E 脚本(`apps/desktop/scripts/`):`e2e-daemon.ts`(宿主全链)/ `e2e-bridge.ts`(工具注册实证)/ `e2e-pi-rpc.ts`、`e2e-orchestrator-live.ts`(真实模型全链,消耗少量配额)。

## 文档

- [业务设计](design/business-design.md) —— 工作区/测试域/记忆域/评审队列全量规格与验收故事
- [技术选型](design/tech-stack.md) —— Electron + React 19 决策与追溯记录(DR-TS-05 起)
- [路线图](design/roadmap-v2.md) —— Router 化:P0~P4(编排/竞赛/任务域)
- [交互原型](prototype/index.html) —— 冻结的交互基线

## 已知边界

- 终端为 ConPTY(DR-TS-05 起,daemon 运行于 Electron/Node;Bun 测试环境下自动回退管道式)
- Windows 优先;macOS 理论可跑(Electron 跨平台),未验证

## License

[MIT](LICENSE)
