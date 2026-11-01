/**
 * JIDE 主进程(P1.5 起 = 薄壳)
 *
 * 职责:窗口 + webview RPC + daemon 生命周期。
 * 宿主服务全部在 daemon 进程(src/bun/daemon.ts,常驻):
 *   - 请求:POST /rpc/<method>(Bearer token)——非窗口本地方法全部代理;
 *   - 事件:WS /events——daemon HostEvent 流 → webview;resync 由 daemon journal 回放。
 * 窗口本地方法(app.hello/project.pickFolder/preview.open/window.*)不出主进程。
 * app 关闭不杀 daemon(agent 与 automations 照跑)。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { BrowserView, BrowserWindow, Updater } from "electrobun/main";
import { openFileDialog } from "electrobun/main/utils";
import type { RPCSchema } from "electrobun/main";
import type { HostEvent, HostRequestShapes } from "@jide/contracts";
import { PROTOCOL_VERSION, isHostEvent } from "@jide/contracts";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/** 运行时数据固定在用户目录,daemon 与主进程必须一致(env JIDE_HOME 透传) */
const RUNTIME_ROOT = process.env.JIDE_HOME ?? join(homedir(), ".jide");
const DAEMON_DIR = join(RUNTIME_ROOT, "daemon");
const HOST_NAME = "jide-host/0.1.0";

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`[jide] HMR enabled: ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log("[jide] Vite dev server 未运行,使用打包视图");
		}
	}
	return "views://mainview/index.html";
}

/* ---------------- daemon 连接 ---------------- */

interface DaemonConn {
	port: number;
	token: string;
	ws: WebSocket | null;
}
let daemon: DaemonConn | null = null;

const log = (msg: string) => console.log(`[jide] ${msg}`);

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
			log(`daemon 复用 :${port}(pid 见 daemon/pid)`);
			return;
		}
	}

	// 拉起新实例(陈旧端口文件先清,防读旧值)
	rmSync(portFile, { force: true });
	rmSync(tokenFile, { force: true });
	const appDir = join(import.meta.dir, "..");
	// 解析顺序:显式 env → dev 源码态(不锁 build2,重建不受阻)→ 打包态 exe → 打包态 cottontail + bundle。
	// 注意:daemon 若从 build2 内的 exe 跑,运行中的 exe 会锁死 build2,hutch 重建即 AccessDenied —— dev 必须走源码。
	const compiled = join(appDir, "jide-daemon.exe");
	const bundled = join(appDir, "jide-daemon.js");
	const cottontail = join(appDir, "..", "..", "bin", "cottontail.exe");
	const devEntry = join(appDir, "..", "..", "..", "..", "..", "src", "bun", "daemon.ts");
	const devCwd = join(appDir, "..", "..", "..", "..", "..");
	let cmd: string[];
	let cwd = appDir;
	if (process.env.JIDE_DAEMON_BIN) cmd = [process.env.JIDE_DAEMON_BIN];
	else if (existsSync(devEntry)) {
		cmd = [process.env.JIDE_DAEMON_BUN ?? "bun", devEntry];
		cwd = devCwd;
	} else if (existsSync(compiled)) cmd = [compiled];
	else if (existsSync(bundled) && existsSync(cottontail)) cmd = [cottontail, bundled];
	else cmd = [process.env.JIDE_DAEMON_BUN ?? "bun", join(import.meta.dir, "daemon.ts")];
	log(`启动 daemon:${cmd.join(" ")}`);
	Bun.spawn(cmd, {
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env, JIDE_HOME: RUNTIME_ROOT },
	});

	for (let i = 0; i < 40; i++) {
		await Bun.sleep(500);
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

/* ---------------- RPC schema(契约不变;窗口本地 + daemon 代理) ---------------- */

type JideRPC = {
	bun: RPCSchema<{
		requests: {
			[K in keyof HostRequestShapes]: {
				params: HostRequestShapes[K]["params"];
				response: HostRequestShapes[K]["response"];
			};
		};
		messages: {
			resync: { lastSeq: number };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			event: HostEvent;
		};
	}>;
};

const emit = (e: HostEvent) => {
	if (!isHostEvent(e)) return;
	(mainWindow.webview.rpc as any)?.send?.event(e);
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
let windowMaximized = false;

const rpc = BrowserView.defineRPC<JideRPC>({
	maxRequestTime: 180_000,
	handlers: {
		requests: {
			/* ---------- 窗口本地(不出主进程) ---------- */
			"app.hello": ({ protocolVersion }: any) => {
				if (protocolVersion !== PROTOCOL_VERSION) {
					return { ok: false, error: `协议不兼容:UI=${protocolVersion}`, expectedProtocolVersion: PROTOCOL_VERSION };
				}
				return { ok: true, protocolVersion: PROTOCOL_VERSION, host: HOST_NAME };
			},
			"project.pickFolder": async () => {
				try {
					const paths = await openFileDialog({
						startingFolder: homedir(),
						allowedFileTypes: "*",
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					});
					return { ok: true, folder: paths[0] ?? null };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"project.pickFile": async () => {
				try {
					const paths = await openFileDialog({
						startingFolder: homedir(),
						allowedFileTypes: "*",
						canChooseFiles: true,
						canChooseDirectory: false,
						allowsMultipleSelection: false,
					});
					return { ok: true, file: paths[0] ?? null };
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
				// 人侧预览:内嵌窗口加载 dev server URL(与 agent 共用同一实例)
				try {
					if (previewWindow) (previewWindow as any).close?.();
					previewWindow = new BrowserWindow({
						title: "JIDE 预览",
						url,
						titleBarStyle: "hiddenInset",
						frame: { width: 520, height: 760, x: 1200, y: 120 },
					});
					emit({ type: "host.log", level: "info", message: "内嵌预览已打开:" + url });
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"window.minimize": () => {
				mainWindow.minimize();
				return { ok: true };
			},
			"window.toggleMaximize": () => {
				try {
					if (windowMaximized) {
						mainWindow.unmaximize();
						windowMaximized = false;
					} else {
						mainWindow.maximize();
						windowMaximized = true;
					}
					return { ok: true, maximized: windowMaximized };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"window.close": () => {
				mainWindow.close();
				return { ok: true };
			},

			/* ---------- daemon 代理(类型化方法全集) ---------- */
			...proxyHandlers,
		} as any,
		messages: {
			resync: ({ lastSeq }: any) => {
				// journal 在 daemon:经事件通道请求回放,事件由 connectEvents 统一转发
				daemon?.ws?.send(JSON.stringify({ type: "resync", lastSeq }));
			},
		},
	},
});

/* ---------------- 窗口 ---------------- */

await ensureDaemon();

const mainWindow = new BrowserWindow({
	title: "JIDE",
	url: await getMainViewUrl(),
	rpc,
	// 无边框:自定义标题栏(hiddenInset = 无系统标题栏但保留 resize 手柄)
	titleBarStyle: "hiddenInset",
	frame: {
		width: 1360,
		height: 860,
		x: 120,
		y: 80,
	},
});

// app 关闭不杀 daemon(常驻:agent 与 automations 照跑;下次启动复用)
console.log(`[jide] 主进程就绪 · shell · protocol=v${PROTOCOL_VERSION} · daemon=${daemon ? `:${daemon.port}` : "未连接"}`);
