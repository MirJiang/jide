import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "JIDE",
		identifier: "dev.jide.desktop",
		version: "0.1.0",
	},
	build: {
		// Cottontail = Bun 衍生运行时(本机工具链已就位)
		// agent 引擎不在 bundle 内:主进程以子进程方式驱动本机安装的
		// pi CLI(pi --mode rpc,JSONL over stdio),复用用户 ~/.pi 的
		// 认证/模型/skills/扩展。pi 相关 npm 依赖仅供测试直接 import。
		mainProcess: "cottontail",
		// 2026-11-01:旧 build/ 树被一个不可见句柄钉住(目录删/改失败,句柄扫描
		// 20 万条无一可见 —— 疑似受保护进程的 watch 句柄),换 buildFolder 绕开;
		// 旧 build/dev-win-x64/JIDE-dev 残壳重启后可删。
		buildFolder: "build2",
		cottontail: {
			entrypoint: "src/bun/index.ts",
			// 主进程动态加载能力(websocket 预留:后续 JIDE 工具桥)
			capabilities: ["websocket"],
		},
		copy: {
			// 前端产物(Vite)→ views://mainview/
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// pi 进程内扩展(jiti 直接跑 TS,宿主经 -e 传给 pi)
			"src/bun/host/extensions": "jide-extensions",
		},
		watchIgnore: ["dist/**", "build/**"],
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
