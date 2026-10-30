import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "JIDE",
		identifier: "dev.jide.desktop",
		version: "0.1.0",
	},
	build: {
		// Cottontail = Bun 衍生运行时(本机工具链已就位)
		// pi SDK 一并打包(esbuild 单文件):cottontail 运行时加载器加载
		// node_modules 下的 ESM(typebox)有兼容问题,打包可绕开。
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
			// pi SDK 运行所需标准库能力(扫描只发现静态引用,这里显式补齐动态引用)
			capabilities: ["websocket"],
		},
		copy: {
			// 前端产物(Vite)→ views://mainview/
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		watchIgnore: ["dist/**", "build/**"],
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
