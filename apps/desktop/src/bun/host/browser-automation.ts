/**
 * BrowserAutomation — 测试域 4C(business-design §4C)
 *
 * 自研轻量 CDP 客户端(原生 WebSocket,无 playwright 依赖):
 *  - playwright-core 在 Bun 下的 WS 传输挂起(pipe 与 connectOverCDP 均超时,spike#M3 记录),
 *    而 Bun 原生 WebSocket 对 Edge CDP 完全可用 —— 直接说 CDP 协议。
 *  - 引擎:系统 Edge(headless,--remote-debugging-port),按需拉起、单实例复用、闲置回收。
 *  - 能力:navigate / click / fill / textContent / capture(截图 → runtime/*.png + base64 回传)。
 *  - 内嵌预览与自动化共用同一 dev server(共引擎原则);M3 的"人侧预览"由
 *    Electrobun 窗口直接加载 dev server URL 实现,与本引擎独立但同源。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmitFn } from "./agent-host";

const EDGE_CANDIDATES = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

interface Engine {
	proc: Process;
	port: number;
	ws: WebSocket | null;
	browserWsUrl: string;
	lastUsed: number;
	msgId: number;
	pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
	pageWsUrl: string | null;
}

export class BrowserAutomation {
	private engines = new Map<string, Engine>();
	private emit: EmitFn = () => {};
	private idleTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private runtimeRoot: string) {}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	/** 按需拉起引擎(每工作区一个端口;agent 与预览共享) */
	async ensureEngine(workspaceId: string, hintPort = 9300): Promise<Engine> {
		const existing = this.engines.get(workspaceId);
		if (existing && existing.ws) {
			existing.lastUsed = Date.now();
			return existing;
		}
		if (existing?.proc) existing.proc.kill();
		const port = hintPort + (this.engines.size % 20);
		const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
		if (!exe) throw new Error("未找到系统 Edge(Chromium)可执行文件");
		const profile = join(this.runtimeRoot, "edge-profiles", workspaceId.replace(/[^a-zA-Z0-9]/g, "_"));
		mkdirSync(profile, { recursive: true });
		const proc = Bun.spawn(
			[
				exe,
				"--headless",
				`--remote-debugging-port=${port}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				`--user-data-dir=${profile}`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		let browserWsUrl = "";
		for (let i = 0; i < 50; i++) {
			try {
				const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
				browserWsUrl = (await r.json()).webSocketDebuggerUrl;
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		if (!browserWsUrl) {
			proc.kill();
			throw new Error("Edge CDP 端口未就绪(12s)");
		}
		const engine: Engine = {
			proc,
			port,
			ws: null,
			browserWsUrl,
			lastUsed: Date.now(),
			msgId: 0,
			pending: new Map(),
			pageWsUrl: null,
		};
		this.engines.set(workspaceId, engine);
		engine.ws = await this.connect(engine, browserWsUrl);
		this.startIdleWatch();
		return engine;
	}

	private connect(engine: Engine, url: string): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 8000);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve(ws);
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("CDP WebSocket 连接失败"));
			};
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(String(ev.data));
					if (msg.id && engine.pending.has(msg.id)) {
						const p = engine.pending.get(msg.id)!;
						engine.pending.delete(msg.id);
						if (msg.error) p.reject(new Error(msg.error.message ?? String(msg.error)));
						else p.resolve(msg.result);
					}
				} catch {
					/* ignore */
				}
			};
			ws.onclose = () => {
				// 连接断开:清空挂起
				for (const [, p] of engine.pending) p.reject(new Error("CDP 连接关闭"));
				engine.pending.clear();
				engine.pageWsUrl = null;
			};
		});
	}

	private send(engine: Engine, method: string, params: Record<string, unknown> = {}): Promise<any> {
		return new Promise((resolve, reject) => {
			const ws = engine.ws;
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error("CDP 未连接"));
				return;
			}
			const id = ++engine.msgId;
			engine.pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (engine.pending.has(id)) {
					engine.pending.delete(id);
					reject(new Error(`CDP 调用超时:${method}`));
				}
			}, 15000);
		});
	}

	/** 页面级 WS(单 page target;懒建) */
	private async pageWs(engine: Engine): Promise<WebSocket> {
		if (engine.pageWsUrl) return engine.ws!; // 复用主连接(Target.attachToTarget 后 sessionId 路由)
		throw new Error("需要先 navigate(建立页面会话)");
	}

	async navigate(workspaceId: string, url: string) {
		const engine = await this.ensureEngine(workspaceId);
		// 打开新标签页(browser WS 上 createTarget),再 attach + Page.navigate(经 flattening session)
		const { targetId } = await this.send(engine, "Target.createTarget", { url: "about:blank" });
		const { sessionId } = await this.send(engine, "Target.attachToTarget", { targetId, flatten: true });
		(engine as any)[`sess-${targetId}`] = sessionId;
		(engine as any).currentTarget = targetId;
		// session 路由的 send
		const sendSession = (method: string, params: Record<string, unknown> = {}) =>
			new Promise((resolve, reject) => {
				const ws = engine.ws!;
				const id = ++engine.msgId;
				engine.pending.set(id, { resolve, reject });
				ws.send(JSON.stringify({ id, method, params, sessionId: (engine as any)[`sess-${targetId}`] }));
				setTimeout(() => {
					if (engine.pending.has(id)) {
						engine.pending.delete(id);
						reject(new Error(`CDP 调用超时:${method}`));
					}
				}, 15000);
			});
		(engine as any).sendSession = sendSession;
		await sendSession("Page.enable");
		await sendSession("Runtime.enable");
		const loaded = new Promise<void>((resolve) => {
			const ws = engine.ws!;
			const onMsg = (ev: MessageEvent) => {
				try {
					const m = JSON.parse(String(ev.data));
					if (m.method === "Page.loadEventFired" && m.sessionId === (engine as any)[`sess-${targetId}`]) {
						ws.removeEventListener("message", onMsg as any);
						resolve();
					}
				} catch {}
			};
			ws.addEventListener("message", onMsg as any);
			setTimeout(resolve, 10000); // 兜底
		});
		await sendSession("Page.navigate", { url });
		await loaded;
		await new Promise((r) => setTimeout(r, 300)); // 渲染缓冲
		const { result } = await sendSession("Runtime.evaluate", { expression: "document.title", returnByValue: true });
		engine.lastUsed = Date.now();
		return { ok: true as const, title: result?.value ?? "" };
	}

	private async eval(workspaceId: string, expression: string) {
		const engine = this.engines.get(workspaceId);
		if (!engine || !(engine as any).sendSession) throw new Error("尚未导航到任何页面");
		const { result, exceptionDetails } = await (engine as any).sendSession("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) throw new Error("页面执行异常:" + (exceptionDetails.exception?.description ?? "").slice(0, 200));
		engine.lastUsed = Date.now();
		return result?.value;
	}

	async click(workspaceId: string, selector: string) {
		const clicked = await this.eval(
			workspaceId,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return { found: false };
				el.scrollIntoView({ block: "center" });
				el.click();
				return { found: true };
			})()`,
		);
		if (!clicked?.found) {
			return { ok: false as const, error: `元素不存在:${selector}(可重试错误)` };
		}
		await new Promise((r) => setTimeout(r, 200));
		return { ok: true as const };
	}

	async fill(workspaceId: string, selector: string, value: string) {
		const filled = await this.eval(
			workspaceId,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return { found: false };
				el.focus();
				el.value = ${JSON.stringify(value)};
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return { found: true };
			})()`,
		);
		if (!filled?.found) return { ok: false as const, error: `元素不存在:${selector}` };
		return { ok: true as const };
	}

	async textContent(workspaceId: string) {
		const text = await this.eval(workspaceId, "document.body.innerText");
		return { ok: true as const, text: String(text ?? "") };
	}

	/** 截图:base64 回传 + 落盘(runtime/browser-shots/,多模态证据链) */
	async capture(workspaceId: string, kind: "shot" = "shot") {
		const engine = this.engines.get(workspaceId);
		if (!engine || !(engine as any).sendSession) return { ok: false as const, error: "尚未导航" };
		const shotDir = join(this.runtimeRoot, "browser-shots");
		mkdirSync(shotDir, { recursive: true });
		const res = await (engine as any).sendSession("Page.captureScreenshot", { format: "png" });
		const dataBase64 = res.data as string;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(shotDir, `${workspaceId.replace(/[^a-zA-Z0-9]/g, "_")}-${stamp}.png`);
		writeFileSync(path, Buffer.from(dataBase64, "base64"));
		engine.lastUsed = Date.now();
		this.emit({
			type: "host.log",
			level: "info",
			message: `浏览器截图已回传(${Math.round(dataBase64.length * 0.75 / 1024)}KB)→ ${path}`,
		});
		return { ok: true as const, dataBase64, path };
	}

	/** 闲置回收(10 分钟) */
	private startIdleWatch() {
		if (this.idleTimer) return;
		this.idleTimer = setInterval(() => {
			const now = Date.now();
			for (const [id, engine] of [...this.engines]) {
				if (now - engine.lastUsed > 10 * 60_000) {
					engine.proc.kill();
					this.engines.delete(id);
					this.emit({ type: "host.log", level: "info", message: "浏览器引擎闲置回收(10min)" });
				}
			}
		}, 60_000);
	}

	disposeAll() {
		if (this.idleTimer) clearInterval(this.idleTimer);
		for (const [, e] of this.engines) e.proc.kill();
		this.engines.clear();
	}
}
