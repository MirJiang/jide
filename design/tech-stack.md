# 技术选型记录

> 状态:全栈已定(2026-11-02):**Electron 45 壳 + Electron/Node 宿主(daemon,经 ELECTRON_RUN_AS_NODE)+ React 19 + Vite 8 + CodeMirror 6**(DR-TS-05)。变更历史见决策记录。
> 本文与业务设计文档互补:业务设计描述「做什么」,本文记录「用什么做」及弃选理由。
> 决策原则:资源占用小、性能好(核心诉求);业务设计第 7 章的架构约束优先于框架偏好。

## 1. 固定底座(不受壳选型影响)

| 组件 | 选型 | 说明 |
|---|---|---|
| agent 宿主 | **Electrobun 主进程(Bun 运行时)内运行 pi**,每会话一个 AgentSession(ThinkRail 同构);`@earendil-works/pi-coding-agent@0.85.1` 钉死基线,升级前必查 CHANGELOG | 不再是独立 Node sidecar;为崩溃隔离预留「拆为 Bun 子进程」的接缝(见 §2 风险) |
| 浏览器自动化/测试引擎 | Playwright(Chromium,CDP) | 仅测试运行时拉起;CDP 后门同时为未来断点调试(非目标)预留 |
| 壳 ↔ 宿主通信 | **类型化 contracts 包**(版本化协议,对齐 ThinkRail `@thinkrail/contracts`);UI ↔ 宿主走 Electrobun RPC / 本地 HTTP+WS | 原「wire 协议三原则」仍适用于协议设计 |
| 终端 | **@xterm/xterm 6** + addons(fit/clipboard/unicode11)+ node-pty(ConPTY,Bun 主进程内) | node-pty 在 Bun 下的兼容性是 spike 项(§6) |

## 2. 桌面壳

### 2.1 现行:Electron 45 ✅(2026-11-02,DR-TS-05)

**结论**:Electron 45(Chromium 156 + Node 24 内置),`electron-builder` 打包(NSIS)。壳 = 窗口 + IPC 代理(`electron/main.ts`);daemon = 同一 electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 执行 Node 化 bundle(`dist-daemon/jide-daemon.js`,经 `src/runtime.ts` 适配层,零 Bun API)——dev 与打包同构,不再携带 cottontail/bun 运行时(原 94MB 归零)。

**改选动因**(Electrobun 实际踩坑):
1. 僵尸 launcher.exe 多次漏杀,「改了没生效」被误判(AGENTS.md 铁律的直接成因);
2. build/ 树被不可见句柄钉死,被迫换 buildFolder 绕行(2026-11-01);
3. ConPTY 在 cottontail 下 socket 即断,终端降级管道式;
4. Windows 支持最晚、上游为小团队项目,存在性风险不可控。
其中 1/2 随换壳消失;3/4 由「daemon 并入 Electron 运行时」根治,顺带解决 94MB 体积。

**取舍**:空闲内存预算由 <350MB 放宽至 ~450MB(换四痛点清零);「轻量」重定义为快、专注、无冗余。

**风险与前置验证**(已全部实测通过):
- `ELECTRON_RUN_AS_NODE` 跑 daemon:health/RPC/WS resync 全链 e2e ✓;
- 进程树:tasklist 实证 daemon 进程为 electron 二进制,无独立 bun/cottontail ✓;
- ConPTY:node-pty@1.1.0 在 Electron 45 下免重建可用,终端升 ConPTY(bun test 仍自动回退管道)✓;
- electron-builder `--dir` 冒烟 ✓(Node 打包)。

### 2.2 历史:Electrobun(2026-10-30 改选,DR-TS-04;已被 DR-TS-05 取代)

**结论**:Electrobun 2.x(ThinkRail 同款,其实测依赖 `electrobun@2.0.5`),Windows 走 WebView2,macOS 用系统 WebKit。单一 TS 技术栈,**无 Rust/Zig 代码需要我们维护**。

**架构**(与 ThinkRail 一致):Electrobun 主进程 = Bun 运行时,内嵌宿主服务(含 pi 会话);渲染层 = 系统 WebView 加载前端产物;`electrobun dev/build` 即开发与打包。

**胜出理由**:
1. 与 ThinkRail **完全同构**——壳、宿主、contracts、打包脚本、工程化可最大程度对照移植;
2. 资源:系统 WebView + Bun,安装包单位数 MB,常驻资源显著优于 Electron;
3. 全 TS 栈,消除 Rust 的编译/维护/迭代摩擦,「壳保持薄」不再必要。

**风险与前置验证**:
- Electrobun Windows 支持晚于 macOS(2025-08 社区仍在修 Windows 构建)——**spike#0 是 M1 门槛**:Electrobun Windows 打包冒烟;若不通过则阻塞开工、重估壳选型(**无预设回退,单向决策**);
- 进程监督、PTY、文件监听等脏活从 Rust crates 转入 Bun 生态,逐项 spike(§6);
- pi 进程内运行 = agent 卡死可能拖住主进程,须实现「会话可中断/可重建」(§6.6)。

**弃选记录**:
- **Tauri 2(前选)** — 彻底弃用:Rust 工具链在本机遗留大体积编译产物与缓存(cargo target/registry,动辄数十 GB),与「资源占用小」初衷相悖;且引入双语言栈。**不留任何形式的兜底**。
- **Electron / Wails / Qt / Flutter** — 理由同前(资源冲突 / 生态沉淀期 / 无编辑器组件)。

## 3. 编辑器:CodeMirror 6 ✅ 已定

- 非目标已砍全量 LSP 与断点调试 → Monaco 的重型语言服务 UI 无用武之地;
- CM6 按需加载语法包、大文件性能好;`@codemirror/merge` 双栏模型与「git diff 双全文模型」天然对齐;
- **架构约束:编辑器一律置于可替换组件抽象之后**(接口:打开/编辑/diff/滚动定位),未来重做 intellisense 或换 Monaco 不牵动全局。

## 4. 前端:React 19 + 自研 UI 包 + Vite ✅ 已定(2026-10-30,依据 ThinkRail 实测依赖)

ThinkRail `apps/web` package.json 实测:React 19 + Zustand 5 + Tailwind v4 + **自研 `@thinkrail/ui` 包** + Vite 8。据此:

| 子项 | 选型 | 说明 |
|---|---|---|
| 框架 / 状态 / 样式 | React 19 + Zustand 5 + Tailwind v4 | 与 ThinkRail 逐项对齐,聊天渲染、工作台布局可直接移植 |
| UI 组件 | **自研 jide-ui 包**(workspace 内),配设计令牌**代码生成 + 校验** | ThinkRail 模式:`generate-colors / spacing / typography` 脚本产出令牌 + usage 测试锁定;不引入重型组件库 |
| 图标 | @remixicon/react | ThinkRail 同款 |
| 虚拟列表 / 拖拽 | react-virtuoso / @dnd-kit/core | 聊天长流、面板与页签布局 |
| Markdown / 高亮 | react-markdown + remark-gfm + shiki | 聊天消息渲染(编辑器高亮仍归 CM6) |
| 终端 UI | @xterm/xterm 6 + addons | 见 §1 |
| 字体 | Geist Variable + JetBrains Mono Variable | UI / 代码,均离线打包 |

**Vite 的结论:保留,必要。** ThinkRail 自己就用 Vite 8(`dev: vite`、`build: vite build`,配 @vitejs/plugin-react + @rolldown/plugin-babel + **React Compiler** + @tailwindcss/vite)。分工:**构建/HMR = Vite;包管理、脚本、单测 = Bun(bun install / bun test)**。

Monaco 在 ThinkRail 中验证了 WebView 内重编辑器可行;我们因砍掉全量 LSP 仍选 CM6,可替换抽象保留为兜底(§3)。

## 5. 资源预算(Windows,数量级估算,同时为验收基线)

| 状态 | 预算 | 备注 |
|---|---|---|
| 空闲(编辑器 + 终端开着) | < 350MB | WebView2 渲染 + GPU + Rust 壳 |
| + agent 会话激活 | +100–200MB | Node sidecar,架构固定成本 |
| + 浏览器级测试运行 | +200–400MB | 仅测试时拉起,平时不驻留 |
| 安装包 | < 10MB | Electrobun 系统 WebView,单位数 MB |
| 冷启动 | < 1.5s | |

## 6. 选型验证 spike(M1 开工前,每项半天到一天)

1. **spike#0(门槛)**:Electrobun **Windows** 打包冒烟——`electrobun build` 出包、WebView2 加载、IPC 通;不通过则阻塞 M1、重估壳选型(无预设回退);
2. **PTY 链路**:node-pty(ConPTY)在 Bun 主进程内 + @xterm/xterm 6,压测大量输出滚动不掉帧;
3. **子进程回收**:壳退出/崩溃时,dev server 与 Playwright 浏览器全量回收(Bun 下无 Rust Job Objects,验证 taskkill /T 或等价方案);
4. **WebView2 内嵌预览**:加载本地 dev server;CDP 附着、与 agent 共引擎;
5. **CM6 性能**:≥10MB 文本打开编辑 + merge 双栏 diff;
6. **pi 会话韧性**:主进程内 AgentSession 卡死/异常时的中断与重建(对应原「sidecar 重启」诉求);
7. **打包实测**:体积/启动/内存对照第 5 节基线。

## 7. ThinkRail 技术栈对照(参考基线)

> 来源:github.com/JetBrains/thinkrail(Apache-2.0,JetBrains 孵化)。实现期引用附录 A 时须注明 commit。

| 层 | ThinkRail | JIDE | 说明 |
|---|---|---|---|
| 引擎宿主 | Bun.serve,pi 进程内(每聊天一 session) | 同构:Electrobun 主进程(Bun)内运行 pi | 我们额外要求「会话可中断 + 预留子进程拆分接缝」 |
| 协议 | packages/contracts(类型化、版本化) | 同款 contracts 包 | 附录 A 对照参考 |
| 前端 | React 19 + Zustand + Tailwind v4 + 自研 ui 包 | 同左(§4) | 直接移植聊天渲染等 |
| 桌面壳 | Electrobun 2.x | **同款 Electrobun 2.x**(Windows=WebView2) | 全对齐,单向决策无回退 |
| 编辑器 | Monaco | CodeMirror 6(可替换抽象) | 我们无全量 LSP,CM6 更轻 |
| 构建/工程 | Vite 8 + Turborepo + Bun + Biome | 同左(Vite 构建 + Bun 包管理/测试) | 含 React Compiler、设计令牌代码生成校验 |
| 测试 | Playwright ×4 套配置 | Playwright | 相互印证 |

## 决策记录

- **DR-TS-01**(2026-10-30,已废弃)桌面壳 = Tauri 2。被 DR-TS-04 取代;用户明确彻底弃用(Rust 编译产物在本机遗留体积大),不留兜底。
- **DR-TS-02**(2026-10-30)编辑器 = CodeMirror 6,强制可替换抽象,理由见 §3。
- **DR-TS-03**(2026-10-30)前端框架 = React 19 + Zustand + Tailwind v4(决策输入「ThinkRail 前端栈」已确认),见 §4。
- **DR-TS-04**(2026-10-30,已被 DR-TS-05 取代)桌面壳改选 **Electrobun**(ThinkRail 同款):pi 进程内、contracts 同构、全 TS 栈;UI 对齐为自研 jide-ui 包 + 设计令牌代码生成;构建保留 Vite,Bun 任包管理/测试。前置 spike#0 验证 Windows;**单向决策,Tauri 彻底移除、不留回退**。覆盖并废弃 DR-TS-01。
- **DR-TS-05**(2026-11-02)桌面壳改选 **Electron 45**,用户拍板(全栈候选重开对比后)。Electrobun 实际踩坑(僵尸 launcher.exe / build 树句柄钉死 / ConPTY 断连 / 94MB cottontail)+ 上游小项目存在性风险 → 换壳;`ELECTRON_RUN_AS_NODE` 吸收 daemon 运行时(Node 化,`src/runtime.ts` 适配层),四痛点一次清零。依赖升级:vite 8 / tailwind 4.3 / react 19.3 / electron-builder 26。Vite/Tailwind/React/CM6 等前端栈不变。覆盖并废弃 DR-TS-04。
- **DR-TS-06**(2026-11-02)**daemon 生命周期 = 跟随 app**(产品决策,用户拍板,推翻旧「关掉 app 照跑」):用户对「关不掉的进程」零容忍,且遗留 agent 会话会隐式消耗模型配额;退出时进程树级回收(taskkill /T,进程名核验防 pid 复用误杀),单实例锁防多壳抽走共享 daemon。**同日交付托盘 opt-in**:设置「关闭窗口驻留后台」开启后,关窗 = 隐藏到托盘(daemon 与自动化继续),真退出走托盘菜单;回收挂 `will-quit`(挂 `window-all-closed` 会在 app.quit() 序列中漏发,实测踩坑)。
