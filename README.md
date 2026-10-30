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
| M1 骨架 | 壳出包 + contracts + pi 会话全链路 | 🚧 进行中 |
| M2 IDE 基面 | 工作区/编辑/终端/对话/计划 | — |
| M3 测试闭环 | dev server/选测/浏览器/检查项/三档 | — |
| M4 记忆 | 建议卡片/三级注入/整理 | — |
