/**
 * pi --mode rpc 子进程客户端(手写 JSONL 协议,零 pi SDK 依赖)
 *
 * 协议(0.85.1 docs/rpc.md,已通读):
 *  - stdin 发 JSON 行命令(带可选 id),stdout 回 JSON 行:`type:"response"`(按 id 关联)与事件流混排;
 *  - 分帧严格 LF-only(Node readline 会按 U+2028/2029 切分,不合规 —— 自己按 \n 切、剥 \r);
 *  - `prompt` 的 response 只代表受理,turn 完成以 `agent_settled` 事件为准;
 *  - 一进程一会话;崩溃后 pending 全部 reject,无自动重启(重建=重 spawn)。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, sleep, spawnSync, type RtSubprocess } from "../../runtime";

export interface PiRpcSpawnOptions {
	nodePath?: string;
	cliPath: string;
	cwd: string;
	sessionDir?: string;
	/** 追加 CLI 参数(-e 扩展、--session、--approve 等) */
	args?: string[];
	env?: Record<string, string>;
	/** 请求默认超时 ms */
	timeoutMs?: number;
}

/** 极简结构类型:只取用到的字段,其余按透传处理 */
export interface PiRpcState {
	sessionId: string;
	sessionFile?: string;
	model?: { id?: string; name?: string; provider?: string } | null;
	thinkingLevel?: string;
	isStreaming?: boolean;
	messageCount?: number;
}

export type PiRpcEventHandler = (event: Record<string, any>) => void;

/** 定位本机安装的 pi CLI(env 覆盖 → npm 全局 → bun 全局 → pi-node 独立目录) */
export function resolvePiCli(): { nodePath: string; cliPath: string } {
	const nodePath = process.env.JIDE_PI_NODE || "node";
	const candidates: string[] = [];
	if (process.env.JIDE_PI_CLI) candidates.push(process.env.JIDE_PI_CLI);
	if (process.env.APPDATA) {
		candidates.push(
			join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
		);
	}
	candidates.push(
		join(homedir(), ".bun", "install", "global", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
	);
	// pi-node 独立安装(<LOCALAPPDATA>\pi-node\current,自带 node 运行时)
	const localApp = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const piNodeCli = join(localApp, "pi-node", "current", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	candidates.push(piNodeCli);
	if (existsSync(piNodeCli)) {
		const piNode = join(localApp, "pi-node", "current");
		const nodeExe = join(piNode, process.platform === "win32" ? "node.exe" : "bin/node");
		if (existsSync(nodeExe)) return { nodePath: nodeExe, cliPath: piNodeCli };
	}
	const hit = candidates.find((p) => existsSync(p));
	if (!hit) {
		throw new Error(
			"未找到本机 pi CLI(已尝试 JIDE_PI_CLI、%APPDATA%\\npm、~/.bun 全局、pi-node 目录)。请先安装 @earendil-works/pi-coding-agent,或设 JIDE_PI_CLI 指向其 dist/bundle/cli.js",
		);
	}
	return { nodePath, cliPath: hit };
}

interface Pending {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient {
	private proc: RtSubprocess;
	private pending = new Map<string, Pending>();
	private listeners = new Set<PiRpcEventHandler>();
	private exitListeners = new Set<(code: number | null) => void>();
	private nextId = 1;
	private stderrTail = "";
	private stopped = false;
	private exitError: Error | null = null;
	readonly timeoutMs: number;

	private constructor(proc: RtSubprocess, timeoutMs: number) {
		this.proc = proc;
		this.timeoutMs = timeoutMs;
		void this.pumpStdout();
		void this.pumpStderr();
		this.proc.exited.then((code) => {
			this.exitError = new Error(`pi 进程已退出(code=${code})${this.stderrTail ? ` · stderr: ${this.tail()}` : ""}`);
			this.failAll(this.exitError);
			for (const cb of this.exitListeners) cb(code);
		});
	}

	/** 启动 pi --mode rpc 子进程并等待其 RPC 通道就绪 */
	static async spawn(opts: PiRpcSpawnOptions): Promise<PiRpcClient> {
		const args = [
			opts.cliPath,
			"--mode",
			"rpc",
			// JIDE 自己承载信任门禁(工作区已在 UI 侧确认);-e 显式扩展不受 --no-extensions 影响,这里不禁用用户扩展
			"--approve",
			...(opts.sessionDir ? ["--session-dir", opts.sessionDir] : []),
			...(opts.args ?? []),
		];
		const proc = spawn([opts.nodePath || "node", ...args], {
			cwd: opts.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...(opts.env ?? {}) },
		});
		const client = new PiRpcClient(proc, opts.timeoutMs ?? 30_000);
		// RPC 通道就绪 = get_state 有响应(进程启动含模型目录刷新,轮询兜底)
		const deadline = Date.now() + 20_000;
		let lastErr: Error | null = null;
		while (Date.now() < deadline) {
			if (client.exitError) throw client.exitError;
			try {
				await client.request({ type: "get_state" }, 5_000);
				return client;
			} catch (err) {
				lastErr = err as Error;
				await sleep(400);
			}
		}
		client.stop();
		throw lastErr ?? new Error("pi RPC 通道 20s 未就绪");
	}

	// ── 事件 ────────────────────────────────────────────────────────────
	onEvent(cb: PiRpcEventHandler): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	onExit(cb: (code: number | null) => void): () => void {
		this.exitListeners.add(cb);
		return () => this.exitListeners.delete(cb);
	}

	// ── 命令 ────────────────────────────────────────────────────────────
	private request(cmd: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<any> {
		if (this.exitError) return Promise.reject(this.exitError);
		const id = `r${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`pi RPC 超时(${timeoutMs}ms):${cmd.type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write(JSON.stringify({ id, ...cmd }));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	private write(line: string) {
		const sink = this.proc.stdin as unknown as { write: (s: string) => number; flush: () => void };
		sink.write(`${line}\n`);
		sink.flush();
	}

	prompt(text: string) {
		return this.request({ type: "prompt", message: text });
	}

	steer(text: string) {
		return this.request({ type: "steer", message: text });
	}

	abort() {
		return this.request({ type: "abort" });
	}

	getState() {
		return this.request({ type: "get_state" }) as Promise<PiRpcState>;
	}

	getMessages() {
		return this.request({ type: "get_messages" }) as Promise<{ messages: any[] }>;
	}

	/** 切换模型(pi set_model;返回完整 Model 对象) */
	setModel(provider: string, modelId: string) {
		return this.request({ type: "set_model", provider, modelId }) as Promise<any>;
	}

	/** 设置思考等级(pi set_thinking_level) */
	setThinkingLevel(level: string) {
		return this.request({ type: "set_thinking_level", level }) as Promise<any>;
	}

	/** 当前模型支持的思考等级(pi get_available_thinking_levels;{levels: string[]}) */
	getAvailableThinkingLevels() {
		return this.request({ type: "get_available_thinking_levels" }) as Promise<{ levels: string[] }>;
	}

	/** 列出全部已配置模型(pi get_available_models;{models: Model[]}) */
	getAvailableModels() {
		return this.request({ type: "get_available_models" }, 20_000) as Promise<{ models: any[] }>;
	}

	/** 运行时回复扩展 UI 请求(ctx.ui.select/confirm/...),预留 */
	respondExtensionUI(payload: Record<string, unknown>) {
		this.write(JSON.stringify(payload));
	}

	// ── 生命周期 ────────────────────────────────────────────────────────
	/** 终止子进程(Windows 按项目惯例 taskkill 连树) */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		const pid = this.proc.pid;
		if (process.platform === "win32") {
			spawnSync(["taskkill", "/PID", String(pid), "/F", "/T"]);
		} else {
			try {
				this.proc.kill();
			} catch {
				// 已退出
			}
		}
	}

	/** 优雅收尾:关 stdin 让 pi 自然退出;超时再强杀 */
	async dispose(graceMs = 3_000) {
		if (this.stopped) return;
		try {
			(this.proc.stdin as unknown as { end: () => void }).end();
		} catch {
			// 已关
		}
		const timer = setTimeout(() => this.stop(), graceMs);
		await this.proc.exited;
		clearTimeout(timer);
		this.stopped = true;
	}

	/** 诊断:最近 stderr(崩溃时看这个) */
	tail(): string {
		return this.stderrTail.slice(-4_000);
	}

	// ── 内部 ────────────────────────────────────────────────────────────
	private async pumpStdout() {
		const decoder = new TextDecoder();
		let buf = "";
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n")) >= 0) {
					let line = buf.slice(0, idx);
					buf = buf.slice(idx + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (line.trim()) this.handleLine(line);
				}
			}
		} catch {
			// 进程被杀时读取会抛错,交由 exited 分支收尾
		}
	}

	private async pumpStderr() {
		const decoder = new TextDecoder();
		const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-8_000);
			}
		} catch {
			// 同上
		}
	}

	private handleLine(line: string) {
		let msg: Record<string, any>;
		try {
			msg = JSON.parse(line);
		} catch {
			return; // 非 JSON 行(理论不会有)忽略
		}
		if (msg.type === "response") {
			const key = String(msg.id ?? "");
			const p = this.pending.get(key);
			if (!p) return;
			this.pending.delete(key);
			clearTimeout(p.timer);
			if (msg.success) p.resolve(msg.data ?? msg);
			else p.reject(new Error(`pi RPC 失败:${msg.error ?? "unknown"}`));
			return;
		}
		// extension_ui_request 等也走事件监听者(AgentHost 现阶段不接 UI 协议,预留)
		for (const cb of this.listeners) cb(msg);
	}

	private failAll(err: Error) {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}
