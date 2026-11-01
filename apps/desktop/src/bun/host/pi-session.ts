/**
 * PiSession — AgentEngine 的本机 pi 子进程实现(产品路径)
 *
 * 每会话一个 `pi --mode rpc` 进程;pi 事件线格式 ≈ 进程内事件子集,
 * 透传给 AgentHost 翻译层;assistant 定稿消息在本地缓存供快照。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	extractEngineText,
	toEngineMessages,
	type AgentEngine,
	type EngineEvent,
	type EngineMessage,
} from "./agent-engine";
import { PiRpcClient } from "./pi-rpc-client";

export interface PiSessionOptions {
	nodePath?: string;
	cliPath?: string;
	cwd: string;
	sessionDir: string;
	/** 重建:续接既有会话文件(.jsonl 绝对路径) */
	sessionFile?: string;
	/** 额外 CLI 参数(-e 扩展等) */
	args?: string[];
	/** 会话启动模型(--model provider/id);缺省 = pi 自己的默认 */
	model?: { provider: string; modelId: string };
	/** 传给 pi 进程的额外环境变量(如 JIDE_MEMORY_FILE) */
	env?: Record<string, string>;
	/** 会话创建后由 RPC 事件回填(扩展/进度提示) */
	onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

export class PiSession implements AgentEngine {
	kind = "pi" as const;
	sessionId = "";
	sessionFilePath = "";
	modelLabel = "pi";

	private client: PiRpcClient | null = null;
	private listeners = new Set<(e: EngineEvent) => void>();
	private cached: EngineMessage[] = [];
	private readonly opts: PiSessionOptions;
	/** 主动 dispose 中:onExit 不再报"会话不可用" */
	private disposing = false;

	private constructor(opts: PiSessionOptions) {
		this.opts = opts;
	}

	/** spawn + 等 RPC 就绪 + 回填会话元数据 */
	static async create(opts: PiSessionOptions): Promise<PiSession> {
		const session = new PiSession(opts);
		const client = await session.spawnClient(opts.sessionFile && existsSync(opts.sessionFile) ? opts.sessionFile : undefined);
		session.client = client;

		client.onEvent((e) => session.dispatch(e));
		client.onExit((code) => {
			if (session.disposing) return;
			opts.onLog?.("error", `pi 进程退出(code=${code}),该会话不可用;可点「重建会话」恢复`);
		});

		const state = await client.getState().catch(() => undefined);
		session.sessionId = state?.sessionId ?? `pi-${Date.now()}`;
		session.sessionFilePath = state?.sessionFile ?? opts.sessionFile ?? "";
		const m: any = state?.model;
		session.modelLabel = m?.name ?? (m?.id ? `${m.provider ?? ""}/${m.id}` : "pi");
		return session;
	}

	/** 拉起 pi 子进程(可续接既有会话文件) */
	private async spawnClient(sessionFile?: string): Promise<PiRpcClient> {
		const { resolvePiCli } = await import("./pi-rpc-client");
		const { nodePath, cliPath } = this.opts.cliPath ? { nodePath: this.opts.nodePath, cliPath: this.opts.cliPath } : resolvePiCli();
		const spawnArgs = [...(this.opts.args ?? [])];
		if (sessionFile) spawnArgs.push("--session", sessionFile);
		// 启动模型(cli.md:--model 接受 provider/id;--provider 须与 --model 同传,单旗标足够)
		if (this.opts.model) spawnArgs.push("--model", `${this.opts.model.provider}/${this.opts.model.modelId}`);
		const client = await PiRpcClient.spawn({
			nodePath,
			cliPath,
			cwd: this.opts.cwd,
			sessionDir: this.opts.sessionDir,
			args: spawnArgs,
			env: this.opts.env,
		});
		return client;
	}

	get crashed(): boolean {
		return this.client === null;
	}

	private dispatch(e: Record<string, any>) {
		switch (e.type) {
			case "agent_start":
			case "agent_settled":
			case "tool_execution_start":
			case "tool_execution_end":
			case "message_update":
				this.emit(e as EngineEvent);
				break;
			case "message_end": {
				const msg = e.message;
				if (msg?.role === "assistant") {
					const text = extractEngineText(msg.content);
					if (text) this.cacheAssistant(text);
				}
				this.emit(e as EngineEvent);
				break;
			}
			case "extension_ui_request":
				// RPC Extension UI 子协议:dialog(select/confirm/input/editor)等宿主转发给 UI,
				// 响应经 respondUI 原样带回 id;notify 火后不管。
				this.emit({ type: "extension_ui_request", request: e } as EngineEvent);
				break;
			default:
				break;
		}
	}

	private emit(e: EngineEvent) {
		for (const cb of this.listeners) cb(e);
	}

	private cacheAssistant(text: string) {
		const last = this.cached[this.cached.length - 1];
		if (last?.role === "assistant" && last.text === text) return;
		this.cached.push({ role: "assistant", text });
	}

	onEvent(cb: (e: EngineEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	async prompt(text: string): Promise<void> {
		if (!this.client) throw new Error("pi 进程已退出,请重建会话");
		this.cached.push({ role: "user", text });
		try {
			await this.client.prompt(text);
		} catch (err) {
			const msg = String((err as Error)?.message ?? err);
			if (/No API key|API key/i.test(msg)) {
				throw new Error(
					"pi 未找到模型认证:请在终端运行 `pi` 后执行 /login(凭证写入 ~/.pi/agent/auth.json),或设置环境变量(智谱编码计划 ZAI_CODING_CN_API_KEY / ZAI_API_KEY,Anthropic ANTHROPIC_API_KEY 等)后重开会话",
				);
			}
			throw err;
		}
	}

	async abort(): Promise<void> {
		await this.client?.abort();
	}

	/** 插队消息(pi steer):agent 运行中于下个模型调用前送达;空闲时 pi 会拒绝并报错 */
	async steer(text: string): Promise<void> {
		if (!this.client) throw new Error("pi 进程已退出,请重建会话");
		await this.client.steer(text);
	}

	/** 切换模型(pi set_model,即时生效);成功后更新 modelLabel 并返回显示名 */
	async setModel(provider: string, modelId: string): Promise<string> {
		if (!this.client) throw new Error("pi 进程已退出,请重建会话");
		const m = await this.client.setModel(provider, modelId);
		const label = String(m?.name ?? (m?.id ? `${m.provider ?? provider}/${m.id}` : `${provider}/${modelId}`));
		this.modelLabel = label;
		return label;
	}

	/** 回复扩展 UI 请求(RPC Extension UI 子协议;requestId 为 pi 侧 id 原样) */
	respondUI(resp: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }) {
		if (!this.client) return; // 进程已退出,响应无处可去
		const payload: Record<string, unknown> = { type: "extension_ui_response", id: resp.requestId };
		if (resp.cancelled) payload.cancelled = true;
		if (resp.value !== undefined) payload.value = resp.value;
		if (resp.confirmed !== undefined) payload.confirmed = resp.confirmed;
		this.client.respondExtensionUI(payload);
	}

	snapshotMessages(): EngineMessage[] {
		return [...this.cached];
	}

	async messages(): Promise<EngineMessage[]> {
		if (!this.client) return this.cached;
		const r = await this.client.getMessages();
		this.cached = toEngineMessages(r?.messages ?? []);
		return [...this.cached];
	}

	/** 进程崩溃后的重建路径:重新拉起并续接同一会话文件 */
	async respawn(): Promise<void> {
		this.client?.stop();
		this.client = null;
		const client = await this.spawnClient(this.sessionFilePath || undefined);
		this.client = client;
		client.onEvent((e) => this.dispatch(e));
		client.onExit((code) => {
			if (this.disposing) return;
			this.opts.onLog?.("error", `pi 进程退出(code=${code}),该会话不可用;可点「重建会话」恢复`);
		});
		const state = await client.getState().catch(() => undefined);
		this.sessionId = state?.sessionId ?? this.sessionId;
		this.sessionFilePath = state?.sessionFile ?? this.sessionFilePath;
		this.cached = await this.messages();
	}

	async dispose(): Promise<void> {
		this.disposing = true;
		const client = this.client;
		this.client = null;
		if (client) await client.dispose();
	}
}

/** 会话目录内给 pi 的注入文本落盘路径(经环境变量传给 jide-memory 扩展) */
export function memoryFilePath(sessionDir: string) {
	return join(sessionDir, ".jide-memory.md");
}
