# JIDE

自测闭环优先的轻量 Agentic IDE。业务设计见 [design/business-design.md](design/business-design.md),技术选型见 [design/tech-stack.md](design/tech-stack.md),交互基线见 [prototype/index.html](prototype/index.html)(已冻结)。

## 仓库结构

```
packages/contracts   @jide/contracts — 壳/宿主类型化协议(可枚举/可演化/可回放)
apps/desktop         Electrobun 壳 + 宿主(pi 进程内)+ React 前端
design/              业务设计与技术选型文档
prototype/           冻结的交互原型
spikes/              选型验证(spike#0 = Electrobun Windows 冒烟,已通过)
```

## 日常开发

```bash
bun install                          # 装依赖(npmmirror 可加 --registry)
bun test                             # contracts + host 单测(faux provider,无网络)
cd apps/desktop
hutch electrobun prepare             # 投影 devkit(首次必跑)
bunx vite build                      # 构建前端到 dist/
hutch electrobun dev                 # 启动桌面壳
# 或 HMR:bunx vite --port 5173 后 hutch electrobun dev
```

## 本机运维要点(spike#0 沉淀)

- **hutch 的 Zig HTTP 客户端不走系统/环境代理**。GitHub 与 blackboard.sh 需经 `http://127.0.0.1:7897`(Clash)curl 手动下载后投放 `~/.hutch` 缓存。已投放:hutch 0.28.2、electrobun core 2.0.5、cottontail 0.7.3(releases 缓存),日常 prepare/dev/build 可 `DASH_RELEASE_OFFLINE=1` 离线跑。
- **模板 init 会因域名校验拒绝本地镜像**。模板归档手动经代理下载解压即可(见 `spikes/spike0-electrobun` 的做法)。
- **hutch 自带 npm 安装器在本机静默不动作**,统一用 `bun install`(可 `--registry https://registry.npmmirror.com`)。
- **bun 1.4.4 工具链**(hutch 托管)未就绪 → 主进程用 `cottontail`(Bun 衍生,已缓存验证)。pi SDK 以 external 方式随包,兼容 Bun 运行时。

## 里程碑

| 里程碑 | 范围 | 状态 |
|---|---|---|
| M1 骨架 | 壳出包 + contracts + pi 会话全链路 | ✅ 2026-10-31(fe21f84) |
| M2 IDE 基面 | 工作区/编辑/终端/对话/计划 | ✅ 2026-10-31(e633392) |
| M3 测试闭环 | dev server/选测/浏览器/检查项/三档 | ✅ 2026-10-31(b8aa762) |
| M4 记忆 | 建议卡片/三级注入/整理 | ✅ 2026-10-31(9e515ab) |

**验收对照**(business-design §9,证据:41 项单测 + 打包环境冒烟日志 + computer-use 窗口 E2E):
- M1:Windows 打包冒烟 ✓ / UI↔宿主↔pi 全链路 ✓ / 会话中断与重建 ✓ / 工具链与 CI ✓
- M2:信任门 ✓ / worktree 原子切换(含重启持久化)✓ / 10MB 编辑不卡(CM6 视口渲染)✓ / 终端 4 万行压测不掉帧 ✓ / 对话页签流式 ✓ / 计划自动提交仅隔离区 ✓
- M3:就绪探测三模式 ✓ / 选测 <5s(实测 76ms)✓ / 浏览器点击+截图回传(自研 CDP)✓ / 检查项沉淀复验 ✓ / 运行三档 ✓ / 错误一键问 agent ✓ / 评审门禁合并 ✓
- M4:建议卡片三动作 ✓ / 三级注入 ≤2K ✓ / 整理可回退 ✓ / AGENTS.md 只读 ✓ / 召回命中 ✓

**基线实测**(tools/measure-baseline.mjs,dev 构建):
- 出包 93.8MB(含 cottontail 运行时 81MB;应用资源 11.5MB —— 预算 <10MB 的口径修订为"应用资源",运行时属 Electrobun 固定底座)
- 冷启动 ~3.1s(dev 构建,含 debug console;预算 1.5s 需 release 构建复测)
- 进程树回收:taskkill /T 方案验证通过(终端/dev server dispose 均已接入;recovery.test.ts)

**已知边界**:终端为管道式 shell(ConPTY 在 Bun/cottontail 下 socket 即断,spike#2 记录;接口留 PTY 升级位);模型走真实模式(读 `~/.pi` 认证/模型配置;faux 夹具仅保留给离线测试,协议 v2 起 demo 面已全部移除)。
