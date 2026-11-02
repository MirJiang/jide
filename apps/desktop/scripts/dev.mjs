/**
 * dev 编排脚本(供 root package.json 的 dev 调用,DR-TS-05 起 Electron 版):
 *  1. 清理占用 5173 的残留 dev server;
 *  2. 起 vite dev server(React Fast Refresh);
 *  3. 构建产物:daemon bundle(dist-daemon)+ Electron main/preload(dist-electron,CJS);
 *  4. 拉起 electron(apps/desktop,main 字段指向 dist-electron/main.js)——
 *     壳探测到 5173 即加载 dev server([jide] HMR enabled)。
 * renderer 改动即时热更;src/bun(daemon)与 electron/(壳)改动需重启本脚本。
 * Ctrl-C / 任一子进程退出 → 一起回收。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

const root = join(import.meta.dir, "..");
const VITE_PORT = 5173;

// 预检:清掉占用 5173 的残留 dev server(此前会话泄漏会让窗口连到旧代码)
const stale = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr :${VITE_PORT} | findstr LISTENING`]);
const stalePid = stale.stdout.toString().trim().split(/\r?\n/)[0]?.trim().split(/\s+/).pop();
if (stalePid && /^\d+$/.test(stalePid)) {
	console.log(`[dev] 端口 ${VITE_PORT} 被残留进程 ${stalePid} 占用,清理…`);
	Bun.spawnSync(["taskkill", "/PID", stalePid, "/F", "/T"]);
	await Bun.sleep(500);
}

// 1) vite dev server(直接用本地依赖入口,不经 bunx 解析)
const vite = Bun.spawn(
	[process.execPath, join(root, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--host", "127.0.0.1"],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);

// 2) 等就绪(与壳 getMainView 同款 HEAD 探测;单次带超时——vite8/rolldown 冷启动慢,
//    无超时的请求会挂死在已监听但未就绪的端口上,最多 20 次有效探测)
let ready = false;
for (let i = 0; i < 60; i++) {
	try {
		const r = await fetch(`http://localhost:${VITE_PORT}`, {
			method: "HEAD",
			signal: AbortSignal.timeout(1500),
		});
		if (r.ok) {
			ready = true;
			break;
		}
	} catch {
		/* 尚未监听/未就绪 */
	}
	await Bun.sleep(500);
}
if (!ready) {
	console.error(`[dev] vite dev server :${VITE_PORT} 20s 未就绪,退出`);
	vite.kill();
	process.exit(1);
}
console.log(`[dev] vite ready on :${VITE_PORT},building daemon + electron shell…`);

// 3a) daemon bundle(Node 目标:壳以 ELECTRON_RUN_AS_NODE 执行,dev 与打包同构;
//     node-pty 为原生模块保持 external,运行时从 node_modules / 资源目录解析)
const daemonBuild = Bun.spawnSync(
	[process.execPath, "build", join(root, "src", "bun", "daemon.ts"), "--target=node", "--external:node-pty", "--outfile", join(root, "dist-daemon", "jide-daemon.js")],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (daemonBuild.exitCode !== 0) {
	console.error("[dev] daemon bundle 构建失败");
	vite.kill();
	process.exit(1);
}

// 3b) Electron main + preload(Node 目标 CJS;electron 保持 external)
const shellBuild = Bun.spawnSync(
	[
		process.execPath, "build",
		join(root, "electron", "main.ts"),
		"--target=node", "--format=cjs", "--packages=external",
		"--outfile", join(root, "dist-electron", "main.js"),
	],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);
const preloadBuild = Bun.spawnSync(
	[
		process.execPath, "build",
		join(root, "electron", "preload.ts"),
		"--target=node", "--format=cjs", "--packages=external",
		"--outfile", join(root, "dist-electron", "preload.js"),
	],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (shellBuild.exitCode !== 0 || preloadBuild.exitCode !== 0) {
	console.error("[dev] electron main/preload 构建失败");
	vite.kill();
	process.exit(1);
}

// 4) electron(直用本依赖二进制,跳过 cli.js 间接层,退出信号干净)
const electronExe = join(root, "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(electronExe)) {
	console.error(`[dev] 未找到 electron 二进制:${electronExe}(bun install 后置脚本未跑?)`);
	vite.kill();
	process.exit(1);
}
const electron = Bun.spawn([electronExe, "."], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
	env: {
		...process.env,
		// 旧变量名兼容:透传为 Vite 可注入渲染层的 VITE_ 前缀
		VITE_JIDE_DEV_PROJECT: process.env.JIDE_DEV_PROJECT ?? "",
	},
});

// 5) 任一退出 → 一起退(Ctrl-C 走 SIGINT 分支)
const cleanup = () => {
	vite.kill();
	electron.kill();
};
process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});
const who = await Promise.any([vite.exited.then(() => "vite"), electron.exited.then(() => "electron")]);
console.log(`[dev] ${who} 已退出,回收另一进程`);
cleanup();
process.exit(0);
