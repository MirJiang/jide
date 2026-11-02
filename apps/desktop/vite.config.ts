import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
	plugins: [react(), tailwindcss()],
	root: "src/mainview",
	// 构建态相对路径(Electron loadFile 必须);dev 态必须 "/",否则 entry 相对化成
	// ./main.tsx → /main.tsx(404),窗口白屏
	base: command === "build" ? "./" : "/",
	build: {
		// apps/desktop/dist(outDir 相对 root 解析,用绝对路径防歧义;electron-builder files 根)
		outDir: resolve(__dirname, "dist"),
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
}));
