/**
 * JIDE 主进程入口:窗口 + RPC(electrobun/main)
 *
 * UI↔宿主通信走 @jide/contracts:
 *  - requests:app.hello / session.*(UI → 宿主,枚举于 contracts)
 *  - messages:bun.messages.resync(view→bun 回放同步)/ webview.messages.event(bun→view 事件流)
 */

import { BrowserView, BrowserWindow, Updater } from "electrobun/main";
import type { RPCSchema } from "electrobun/main";
import type {
	HostRequestShapes,
	HostEvent,
	HostRequestHandlers,
} from "@jide/contracts";
import { PROTOCOL_VERSION, isHostEvent } from "@jide/contracts";
import { AgentHost, HOST_NAME } from "./host/agent-host";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/** M1:demo 模式默认开(faux 全链路本地演练);真实模型接入后改为可配置 */
const DEMO_DEFAULT = process.env.JIDE_DEMO !== "0";

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

/* ---------------- RPC schema(由 contracts 派生,单事件通道) ---------------- */

type JideRPC = {
	bun: RPCSchema<{
		requests: {
			[K in keyof HostRequestShapes]: {
				params: HostRequestShapes[K]["params"];
				response: HostRequestShapes[K]["response"];
			};
		};
		messages: {
			/** UI 报告已消费到的 seq,宿主据此补发缺口(连接/重连回放) */
			resync: { lastSeq: number };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			/** 宿主 → UI 的唯一推送通道:协议事件流 */
			event: HostEvent;
		};
	}>;
};

const host = new AgentHost();

const rpc = BrowserView.defineRPC<JideRPC>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			"app.hello": ({ protocolVersion }) => {
				if (protocolVersion !== PROTOCOL_VERSION) {
					return {
						ok: false,
						error: `协议不兼容:UI=${protocolVersion}`,
						expectedProtocolVersion: PROTOCOL_VERSION,
					};
				}
				return {
					ok: true,
					protocolVersion: PROTOCOL_VERSION,
					host: HOST_NAME,
					demo: DEMO_DEFAULT,
				};
			},
			"session.create": async ({ workspacePath, demoMode }) => {
				try {
					const entry = await host.createSession({
						workspacePath,
						demoMode: demoMode ?? DEMO_DEFAULT,
					});
					return {
						ok: true,
						sessionId: entry.sessionId,
						modelLabel: entry.modelLabel,
						demo: entry.demo,
					};
				} catch (err: any) {
					host.log("error", `会话创建失败:${err?.message ?? err}`);
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.prompt": async ({ sessionId, text }) => {
				try {
					await host.prompt(sessionId, text);
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.abort": async ({ sessionId }) => {
				try {
					await host.abort(sessionId);
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.rebuild": async ({ sessionId }) => {
				try {
					const { entry, restored } = await host.rebuild(sessionId);
					return {
						ok: true,
						sessionId: entry.sessionId,
						restoredMessages: restored,
					};
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.get": ({ sessionId }) => {
				const snap = host.getSnapshot(sessionId);
				if (!snap) return { ok: false, error: `会话不存在:${sessionId}` };
				return { ok: true, ...snap };
			},
		} satisfies HostRequestHandlers as any,
		messages: {
			resync: ({ lastSeq }) => {
				for (const event of host.eventsSince(lastSeq)) {
					pushEvent(event);
				}
			},
		},
	},
});

const mainWindow = new BrowserWindow({
	title: "JIDE",
	url: await getMainViewUrl(),
	rpc,
	frame: {
		width: 980,
		height: 780,
		x: 160,
		y: 120,
	},
});

function pushEvent(event: HostEvent) {
	if (!isHostEvent(event)) return;
	(mainWindow.webview.rpc as any)?.send?.event(event);
	if (event.type === "host.log") {
		console.log(`[jide:host] ${event.level} ${event.message}`);
	}
}

/* 事件出口:journal → RPC 推送(事件流即日志) */
host.bindEmitter(pushEvent);

console.log(
	`[jide] 主进程就绪 · host=${HOST_NAME} · protocol=v${PROTOCOL_VERSION} · demo=${DEMO_DEFAULT}`,
);

/* E2E 冒烟钩子:JIDE_SMOKE=1 时自动走 创建→prompt→(可选中断)→重建,日志可断言 */
if (process.env.JIDE_SMOKE === "1") {
	const entry = await host.createSession({ workspacePath: "", demoMode: true });
	await host.prompt(entry.sessionId, "smoke: 全链路").catch((e) =>
		console.log(`[jide:smoke] prompt err ${e}`),
	);
	console.log("[jide:smoke] prompt done, rebuilding…");
	const r = await host.rebuild(entry.sessionId).catch((e) => {
		console.log(`[jide:smoke] rebuild err ${e}`);
		return null;
	});
	console.log(
		`[jide:smoke] rebuild done restored=${r?.restored ?? "n/a"}`,
	);
}
