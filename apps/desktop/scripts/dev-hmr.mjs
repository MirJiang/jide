/**
 * dev-HMR 编排脚本(供 root package.json 的 desktop:hmr 调用):
 *  1. 起 vite dev server(5173,React Fast Refresh);
 *  2. 探测就绪后拉起 `hutch electrobun dev` —— 宿主 getMainViewUrl 会探测到
 *     5173 并让窗口加载 dev server([jide] HMR enabled);
 *  3. 此后 renderer(React/CSS)改动即时热更,无需重启。
 * 宿主(src/bun)改动仍需重启;可传 --watch 尝试 electrobun 的自动重启。
 * Ctrl-C / 任一子进程退出 → 两个一起回收。
 */

import { join } from "node:path";
import { dlopen, ptr } from "bun:ffi";

const root = join(import.meta.dir, "..");
const VITE_PORT = 5173;
const passWatch = process.argv.includes("--watch");

// 预检:清掉占用 5173 的残留 dev server(此前会话泄漏会让窗口连到旧代码)
const stale = Bun.spawnSync(["cmd", "/c", `netstat -ano | findstr :${VITE_PORT} | findstr LISTENING`]);
const stalePid = stale.stdout.toString().trim().split(/\r?\n/)[0]?.trim().split(/\s+/).pop();
if (stalePid && /^\d+$/.test(stalePid)) {
	console.log(`[dev-hmr] 端口 ${VITE_PORT} 被残留进程 ${stalePid} 占用,清理…`);
	Bun.spawnSync(["taskkill", "/PID", stalePid, "/F", "/T"]);
	await Bun.sleep(500);
}

// 1) vite dev server(直接用本地依赖入口,不经 bunx 解析)
const vite = Bun.spawn(
	[process.execPath, join(root, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--host", "127.0.0.1"],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);

// 2) 等就绪(与宿主 getMainViewUrl 同款 HEAD 探测,最多 20s)
let ready = false;
for (let i = 0; i < 40; i++) {
	try {
		const r = await fetch(`http://localhost:${VITE_PORT}`, { method: "HEAD" });
		if (r.ok) {
			ready = true;
			break;
		}
	} catch {
		/* 尚未监听 */
	}
	await Bun.sleep(500);
}
if (!ready) {
	console.error(`[dev-hmr] vite dev server :${VITE_PORT} 20s 未就绪,退出`);
	vite.kill();
	process.exit(1);
}
console.log(`[dev-hmr] vite ready on :${VITE_PORT},launching electrobun dev…`);

// 3) electrobun:prepare(需 daemon bundle 先产出,config copy 依赖)→ 补丁 exe 图标 → run
const daemonBuild = Bun.spawnSync([process.execPath, "build", join(root, "src", "bun", "daemon.ts"), "--target=bun", "--outfile", join(root, "dist-daemon", "jide-daemon.js")], {
	cwd: root, stdout: "inherit", stderr: "inherit",
});
if (daemonBuild.exitCode !== 0) {
	console.error("[dev-hmr] daemon bundle 构建失败");
	vite.kill();
	process.exit(1);
}
const prep = Bun.spawnSync(["hutch", "electrobun", "prepare"], {
	cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, DASH_RELEASE_OFFLINE: "1" },
});
if (prep.exitCode !== 0) {
	console.error("[dev-hmr] electrobun prepare 失败");
	vite.kill();
	process.exit(1);
}
Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "patch-exe-icon.ps1")], { stdout: "inherit", stderr: "inherit" });
const eb = Bun.spawn(
	["hutch", "electrobun", "run"],
	{ cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, DASH_RELEASE_OFFLINE: "1" } },
);

// 4.5) 应用图标(Electrobun 无 API):等窗口出现后 WM_SETICON 注入 Neon J。
// 必须由常驻进程创建 HICON:bun:ffi 在本进程 LoadImage,句柄随 dev-hmr 存活。
// (旧方案用 powershell 一次性注入,PS 退出时 HICON 被系统销毁 → 任务栏悬空句柄回退通用图标)
const user32 = dlopen("user32.dll", {
	FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
	LoadImageW: { args: ["ptr", "ptr", "u32", "i32", "i32", "u32"], returns: "ptr" },
	SendMessageW: { args: ["ptr", "u32", "u64", "u64"], returns: "i32" },
});
const icoPath = join(root, "assets", "neon-j.ico");
const wstr = (s) => ptr(Buffer.from(`${s}\0`, "utf16le"));
const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, WM_SETICON = 0x80;
const hBig = user32.symbols.LoadImageW(null, wstr(icoPath), IMAGE_ICON, 32, 32, LR_LOADFROMFILE) || null;
const hSmall = hBig ? (user32.symbols.LoadImageW(null, wstr(icoPath), IMAGE_ICON, 16, 16, LR_LOADFROMFILE) || hBig) : null;
if (!hBig) console.log("[dev-hmr] icon inject: LoadImage failed (skipped)");
else {
	(async () => {
		for (let i = 0; i < 60; i++) {
			await Bun.sleep(1000);
			const hwnd = user32.symbols.FindWindowW(null, wstr("JIDE"));
			if (hwnd) {
				user32.symbols.SendMessageW(hwnd, WM_SETICON, 0, Number(hBig));
				user32.symbols.SendMessageW(hwnd, WM_SETICON, 1, Number(hSmall || hBig));
				console.log(`[dev-hmr] taskbar icon set (hwnd=${hwnd}, hicon=${hBig})`);
				return;
			}
		}
		console.log("[dev-hmr] icon inject: window not found (skipped)");
	})();
}

// 4) 任一退出 → 一起退(Ctrl-C 走 SIGINT 分支)
const cleanup = () => {
	vite.kill();
	eb.kill();
};
process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});
const who = await Promise.any([vite.exited.then(() => "vite"), eb.exited.then(() => "electrobun")]);
console.log(`[dev-hmr] ${who} 已退出,回收另一进程`);
cleanup();
process.exit(0);
