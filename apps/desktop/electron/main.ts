/**
 * JIDE 主进程(Electron 壳,DR-TS-05 起)
 *
 * 职责:窗口 + IPC RPC + daemon 生命周期。
 * 宿主服务全部在 daemon 进程(src/bun/daemon.ts,常驻):
 *   - 请求:POST /rpc/<method>(Bearer token)——非窗口本地方法全部代理;
 *   - 事件:WS /events——daemon HostEvent 流 → 渲染层;resync 由 daemon journal 回放。
 * 窗口本地方法(app.hello/project.pickFolder/preview.open/window.*)不出主进程。
 * app 关闭不杀 daemon(spawn detached,独立进程组;agent 与 automations 照跑)。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, Tray } from "electron";
// 相对路径引 contracts:随壳内联进 bundle(--packages=external 只外置裸说明符,
// electron 必须外置,contracts 必须内联——打包产物无 node_modules)
import type { HostEvent } from "../../../packages/contracts/src/index";
import { PROTOCOL_VERSION, isHostEvent } from "../../../packages/contracts/src/index";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/** 运行时数据固定在用户目录,daemon 与主进程必须一致(env JIDE_HOME 透传) */
const RUNTIME_ROOT = process.env.JIDE_HOME ?? join(homedir(), ".jide");
const DAEMON_DIR = join(RUNTIME_ROOT, "daemon");
const HOST_NAME = "jide-host/0.1.0";
/** apps/desktop(源码态)/ app.asar(打包态,dist/dist-electron 随包)
 * 用 getAppPath() 而非 __dirname:bun build 会把 __dirname 静态替换为源码目录 */
const APP_DIR = app.getAppPath();

const log = (msg: string) => console.log(`[jide] ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ---------------- daemon 连接 ---------------- */

interface DaemonConn {
	port: number;
	token: string;
	ws: WebSocket | null;
}
let daemon: DaemonConn | null = null;

async function probeDaemon(port: number): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
		return r.ok;
	} catch {
		return false;
	}
}

/** 事件通道(断线 2s 重连;重连即 resync 补缺) */
function connectEvents(port: number, token: string): Promise<void> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
		ws.onopen = () => {
			log(`daemon 事件通道已连接 :${port}`);
			resolve();
		};
		ws.onmessage = (ev) => {
			try {
				const e = JSON.parse(String(ev.data));
				if (isHostEvent(e)) emit(e);
			} catch {
				/* 非 JSON 忽略 */
			}
		};
		ws.onclose = () => {
			if (daemon?.ws === ws) daemon.ws = null;
			log("daemon 事件通道断开,2s 重连…");
			setTimeout(() => {
				if (daemon && daemon.port === port) void connectEvents(port, token);
			}, 2000);
		};
		ws.onerror = () => {
			try {
				ws.close();
			} catch {
				/* 已关 */
			}
		};
		if (daemon) daemon.ws = ws;
	});
}

/** 解析 daemon 启动命令(DR-TS-05):daemon 已 Node 化(src/runtime.ts),
 * 统一用 electron 二进制以 ELECTRON_RUN_AS_NODE 跑 —— dev 与打包同构,零额外运行时 */
function resolveDaemonCmd(): { cmd: string[]; cwd: string; env: Record<string, string> } {
	// 打包态:extraResources daemon/jide-daemon.js;源码态:dist-daemon 产物
	const bundled = app.isPackaged
		? join(process.resourcesPath, "daemon", "jide-daemon.js")
		: join(APP_DIR, "dist-daemon", "jide-daemon.js");
	// cwd 必须是真实目录:打包态 APP_DIR 在 app.asar 内,子进程 CreateProcess 视其为不存在(ENOENT)。
	// dev 态 cwd 指仓库根:daemon 的 extensionsDir 有 process.cwd() 候选(源码态扩展目录)。
	if (process.env.JIDE_DAEMON_BIN) return { cmd: [process.env.JIDE_DAEMON_BIN], cwd: APP_DIR, env: {} };
	const devExtDir = existsSync(join(APP_DIR, "src", "bun", "host", "extensions"))
		? join(APP_DIR, "..", "..")
		: null;
	return {
		cmd: [process.execPath, bundled],
		cwd: devExtDir ?? join(bundled, ".."),
		env: { ELECTRON_RUN_AS_NODE: "1", JIDE_APP_EXE: process.execPath },
	};
}

/** 本壳是否拉起过 daemon(拉起过才有资格回收;复用的外部 daemon 不碰) */
let ownsDaemon = false;

/** 拉起/复用 daemon;返回前事件通道已就绪 */
async function ensureDaemon(): Promise<void> {
	mkdirSync(DAEMON_DIR, { recursive: true });
	const portFile = join(DAEMON_DIR, "port");
	const tokenFile = join(DAEMON_DIR, "token");

	// 复用既有实例
	if (existsSync(portFile) && existsSync(tokenFile)) {
		const port = Number(readFileSync(portFile, "utf8").trim());
		const token = readFileSync(tokenFile, "utf8").trim();
		if (Number.isFinite(port) && token && (await probeDaemon(port))) {
			daemon = { port, token, ws: null };
			await connectEvents(port, token);
			// 上次会话遗留(崩溃/强杀)的 daemon 同样视为己有:进程名核验后随本壳退出回收
			if (processIsJideDaemon(pidFromFiles())) ownsDaemon = true;
			log(`daemon 复用 :${port}(pid 见 daemon/pid)`);
			return;
		}
	}

	// 拉起新实例(陈旧端口文件先清,防读旧值)
	rmSync(portFile, { force: true });
	rmSync(tokenFile, { force: true });
	ownsDaemon = true;
	const { cmd, cwd, env } = resolveDaemonCmd();
	log(`启动 daemon:${cmd.join(" ")}`);
	const child = nodeSpawn(cmd[0], cmd.slice(1), {
		cwd,
		stdio: "ignore",
		detached: true,
		env: { ...process.env, ...env, JIDE_HOME: RUNTIME_ROOT },
	});
	// spawn 失败(ENOENT 等)只有 error 事件可凭;stdio ignore 下必须显式监听,否则静默
	child.on("error", (err) => log(`daemon 进程拉起失败:${err.message}`));
	child.unref();

	for (let i = 0; i < 40; i++) {
		await sleep(500);
		if (existsSync(portFile) && existsSync(tokenFile)) {
			const port = Number(readFileSync(portFile, "utf8").trim());
			const token = readFileSync(tokenFile, "utf8").trim();
			if (Number.isFinite(port) && token && (await probeDaemon(port))) {
				daemon = { port, token, ws: null };
				await connectEvents(port, token);
				log(`daemon 已启动 :${port}`);
				return;
			}
		}
	}
	throw new Error(`daemon 20s 未就绪(查 ${join(DAEMON_DIR, "daemon.log")})`);
}

async function daemonRpc(method: string, params: unknown): Promise<unknown> {
	if (!daemon) throw new Error("daemon 未连接(启动中或已退出)");
	const res = await fetch(`http://127.0.0.1:${daemon.port}/rpc/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
		body: JSON.stringify({ params }),
		// 长轮询上限:agent 轮次/浏览器录屏等最长耗时远低于此
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok) {
		let detail = "";
		try {
			detail = (await res.json())?.error ?? "";
		} catch {
			/* 非 JSON */
		}
		throw new Error(`daemon ${method} 失败(HTTP ${res.status})${detail ? `:${detail}` : ""}`);
	}
	return res.json();
}

/* ---------------- RPC 分发(契约不变;窗口本地 + daemon 代理) ---------------- */

const emit = (e: HostEvent) => {
	if (!isHostEvent(e)) return;
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("jide:event", e);
	if (e.type === "host.log") log(`[host.${e.level}] ${e.message}`);
};

/** daemon 方法全集(窗口本地 6 项除外) */
const DAEMON_METHODS = [
	"session.create",
	"session.prompt",
	"session.abort",
	"session.rebuild",
	"session.get",
	"session.respondUI",
	"session.setModel",
	"session.setThinkingLevel",
	"session.getThinkingLevels",
	"session.setPermissionMode",
	"session.askWithContext",
	"settings.get",
	"settings.set",
	"credential.list",
	"credential.set",
	"credential.delete",
	"project.clone",
	"project.open",
	"project.trust",
	"workspace.list",
	"workspace.create",
	"workspace.remove",
	"workspace.switch",
	"fs.list",
	"fs.read",
	"fs.write",
	"fs.search",
	"terminal.create",
	"terminal.write",
	"terminal.resize",
	"terminal.dispose",
	"plan.create",
	"plan.stepDone",
	"plan.get",
	"git.status",
	"git.log",
	"git.fileDiff",
	"git.sync",
	"git.openPullRequest",
	"git.commitAll",
	"devserver.ensure",
	"devserver.stop",
	"devserver.status",
	"probe.http",
	"test.run",
	"checks.list",
	"checks.create",
	"checks.run",
	"checks.delete",
	"browser.navigate",
	"browser.click",
	"browser.hover",
	"browser.scroll",
	"browser.snapshot",
	"browser.console",
	"browser.record",
	"browser.capture",
	"run.agentSelfTest",
	"review.list",
	"review.decide",
	"review.enqueueCommit",
	"tasks.list",
	"tasks.dismiss",
	"memory.status",
	"memory.suggest",
	"memory.decide",
	"memory.tidy",
	"memory.revertTidy",
	"memory.recall",
	"models.list",
	"automations.list",
	"automations.save",
	"automations.delete",
	"automations.run",
	"automations.runs",
	"orchestrator.workers",
	"races.list",
	"races.start",
	"races.resolve",
	"races.discard",
	"races.cancel",
] as const;

type DaemonMethod = (typeof DAEMON_METHODS)[number];

const proxyHandlers = Object.fromEntries(
	DAEMON_METHODS.map((m) => [
		m,
		async (params: any) => {
			try {
				return await daemonRpc(m, params);
			} catch (err: any) {
				return { ok: false, error: String(err?.message ?? err) };
			}
		},
	]),
) as Record<DaemonMethod, (params: any) => any>;

let previewWindow: BrowserWindow | null = null;

/** 窗口本地方法(不出主进程) */
const windowHandlers: Record<string, (params: any) => unknown> = {
	"app.hello": ({ protocolVersion }: any) => {
		if (protocolVersion !== PROTOCOL_VERSION) {
			return { ok: false, error: `协议不兼容:UI=${protocolVersion}`, expectedProtocolVersion: PROTOCOL_VERSION };
		}
		return { ok: true, protocolVersion: PROTOCOL_VERSION, host: HOST_NAME };
	},
	"project.pickFolder": async () => {
		try {
			const r = await dialog.showOpenDialog(mainWindow!, {
				title: "打开项目(git 仓库)",
				defaultPath: homedir(),
				properties: ["openDirectory"],
			});
			return { ok: true, folder: r.canceled ? null : (r.filePaths[0] ?? null) };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"project.pickFile": async () => {
		try {
			const r = await dialog.showOpenDialog(mainWindow!, {
				title: "选择文件",
				defaultPath: homedir(),
				properties: ["openFile"],
			});
			return { ok: true, file: r.canceled ? null : (r.filePaths[0] ?? null) };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"fs.readAbsolute": ({ path }: any) => {
		try {
			// 附件内联:用户经系统对话框显式选择的文件;文本读取,256KB 截断
			const stat = statSync(path);
			if (stat.size > 4 * 1024 * 1024) return { ok: false, error: "文件超过 4MB,不宜作为附件内联(可改为在消息中引用路径让 agent 自行读取)" };
			const buf = readFileSync(path);
			const capped = buf.subarray(0, 256 * 1024);
			return { ok: true, content: capped.toString("utf8"), size: stat.size, truncated: stat.size > capped.length };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"preview.open": ({ url }: any) => {
		// 人侧预览:独立窗口加载 dev server URL(与 agent 共用同一实例)
		try {
			if (previewWindow) {
				try {
					previewWindow.close();
				} catch {
					/* 已关 */
				}
			}
			previewWindow = new BrowserWindow({
				title: "JIDE 预览",
				width: 520,
				height: 760,
				x: 1200,
				y: 120,
				frame: false,
			});
			void previewWindow.loadURL(url);
			// 注:不带 seq 的 host.log 过不了 isHostEvent(旧壳同样静默丢弃),仅记壳日志
			log("内嵌预览已打开:" + url);
			return { ok: true };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"window.minimize": () => {
		mainWindow?.minimize();
		return { ok: true };
	},
	"window.toggleMaximize": () => {
		try {
			// 以窗口真实状态为准(优于旧壳的 JS 计数标志)
			if (mainWindow?.isMaximized()) mainWindow.unmaximize();
			else mainWindow?.maximize();
			return { ok: true, maximized: mainWindow?.isMaximized() ?? false };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	"window.close": () => {
		mainWindow?.close();
		return { ok: true };
	},
};

async function dispatch(method: string, params: unknown): Promise<unknown> {
	const local = windowHandlers[method];
	if (local) return local(params);
	const proxy = (proxyHandlers as Record<string, (p: any) => any>)[method];
	if (proxy) return proxy(params);
	return { ok: false, error: `未知方法:${method}` };
}

ipcMain.handle("jide:request", (_event, method: string, params: unknown) => dispatch(method, params));

ipcMain.on("jide:resync", (_event, lastSeq: number) => {
	// journal 在 daemon:经事件通道请求回放,事件由 connectEvents 统一转发
	daemon?.ws?.send(JSON.stringify({ type: "resync", lastSeq }));
});

/* ---------------- 窗口 ---------------- */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 真退出标志:置位后窗口 close 不再拦截(托盘「退出」/before-quit 路径) */
let quitting = false;
/** 关闭窗口驻留后台(DR-TS-06 opt-in);启动时读一次,关窗瞬间取实时值 */
let keepInTray = false;

/** 取「驻留后台」设置(daemon 权威;800ms 超时回退缓存) */
async function fetchKeepInTray(): Promise<boolean> {
	try {
		const r = (await Promise.race([
			daemonRpc("settings.get", {}),
			new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800)),
		])) as { ok: boolean; settings?: { keepRunningInTray?: boolean } };
		keepInTray = r?.ok === true && r.settings?.keepRunningInTray === true;
	} catch {
		/* daemon 不可达:沿用缓存 */
	}
	return keepInTray;
}

function showWindow(): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

function createTray(): void {
	try {
		tray = new Tray(join(APP_DIR, "assets", "neon-j.ico"));
	} catch (err: any) {
		log(`托盘创建失败(仅影响驻留入口):${err?.message ?? err}`);
		return;
	}
	tray.setToolTip("JIDE");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "打开 JIDE", click: () => showWindow() },
			{ type: "separator" },
			{
				label: "退出 JIDE",
				click: () => {
					quitting = true;
					app.quit();
				},
			},
		]),
	);
	tray.on("click", () => showWindow());
	log("托盘已就绪(关闭窗口的驻留行为由设置「关闭窗口驻留后台」决定)");
}

async function getMainView(): Promise<{ kind: "url" | "file"; value: string }> {
	if (!app.isPackaged) {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			log(`HMR enabled: ${DEV_SERVER_URL}`);
			return { kind: "url", value: DEV_SERVER_URL };
		} catch {
			log("Vite dev server 未运行,使用打包视图");
		}
	}
	return { kind: "file", value: join(APP_DIR, "dist", "index.html") };
}

async function main() {
	await ensureDaemon();
	void fetchKeepInTray();
	createTray();

	const view = await getMainView();
	mainWindow = new BrowserWindow({
		title: "JIDE",
		// 无边框:自定义标题栏(frame:false = 无系统标题栏,Windows 保留 resize 手柄)
		frame: false,
		width: 1360,
		height: 860,
		x: 120,
		y: 80,
		icon: app.isPackaged ? undefined : join(APP_DIR, "assets", "neon-j.ico"),
		webPreferences: {
			preload: join(APP_DIR, "dist-electron", "preload.js"),
		},
	});
	// 驻留后台拦截:非真退出时,关窗 → 读实时设置 → 藏窗或走真退出
	mainWindow.on("close", (e) => {
		if (quitting) return;
		e.preventDefault();
		void (async () => {
			if (await fetchKeepInTray()) {
				log("驻留后台:窗口已隐藏,agent 与定时自动化继续跑(托盘可恢复/退出)");
				mainWindow?.hide();
			} else {
				quitting = true;
				app.quit();
			}
		})();
	});
	if (view.kind === "url") void mainWindow.loadURL(view.value);
	else void mainWindow.loadFile(view.value);
}

/* ---------------- 生命周期:daemon 跟随 app(DR-TS-05 产品决策) ---------------- */

/** 读取 daemon/pid 文件中的 pid(缺失/非法返回 0) */
function pidFromFiles(): number {
	try {
		const pid = Number(readFileSync(join(DAEMON_DIR, "pid"), "utf8").trim());
		return Number.isFinite(pid) && pid > 0 ? pid : 0;
	} catch {
		return 0;
	}
}

/** 进程名核验:该 pid 是否为 JIDE 自家 daemon(electron/JIDE 二进制)。
 * 防 pid 复用误杀:注册表式只杀确认姓 JIDE 的。 */
function processIsJideDaemon(pid: number): boolean {
	if (!pid) return false;
	try {
		const out = nodeSpawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
		const image = out.stdout?.toString().split(",")[0]?.trim().replaceAll('"', "") ?? "";
		return /^(electron|JIDE)\.exe$/i.test(image);
	} catch {
		return false;
	}
}

/** 回收 daemon 进程树(win32 taskkill /T:连 pi/dev server/终端一起收)。
 * 必须阻塞执行:主进程随即 quit,异步 spawn 的 taskkill 会被连带带死(实测踩坑)。 */
function killDaemon(): void {
	const pid = pidFromFiles();
	if (!pid) return;
	log(`回收 daemon(pid ${pid})`);
	if (process.platform === "win32") {
		const r = nodeSpawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 5000,
		});
		if (r.status !== 0) log(`taskkill 退出码异常:${r.status}(daemon 可能已退出)`);
	} else {
		try {
			process.kill(pid);
		} catch {
			/* 已退 */
		}
	}
}

// 单实例锁:二次启动聚焦已有窗口(否则后开的壳退出时会把共享 daemon 从先开的窗口脚下抽走)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => {
	showWindow();
});

void app
	.whenReady()
	.then(() => {
		if (!gotLock) return;
		return main();
	})
	.catch((err) => {
		console.error("[jide] 主进程启动失败:", err);
		app.quit();
	});

// 真退出路径(托盘「退出」/ app.quit / 系统关机)统一置位,窗口 close 不再被驻留逻辑拦截
app.on("before-quit", () => {
	quitting = true;
});

// DR-TS-06(2026-11-02):默认 daemon 跟随 app 退出。回收挂 will-quit 而非 window-all-closed:
// app.quit() 序列(before-quit → 关窗 → will-quit)不经过 window-all-closed,挂那里会漏
// (实测踩坑:退出分支 daemon 存活)。自然关窗(Windows 惯例)转 app.quit()。
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
	if (ownsDaemon || processIsJideDaemon(pidFromFiles())) killDaemon();
});
