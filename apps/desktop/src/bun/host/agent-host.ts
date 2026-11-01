/**
 * AgentHost — 主进程内的 agent 会话宿主(business-design §7.1)
 *
 * 职责:
 *  - 管理会话生命周期:创建 / prompt / 中断 / 重建 / 销毁;
 *  - 把引擎事件流翻译为 @jide/contracts 的 HostEvent(带 seq,可回放);
 *  - 引擎缝(agent-engine.ts):
 *      · 真实模式 = 本机 pi CLI 子进程(pi --mode rpc,pi-session.ts),
 *        复用用户自己的 ~/.pi 认证/模型/skills/扩展,JIDE 不再内置 pi SDK;
 *      · 演示模式 = DemoEngine(demo-engine.ts,进程内脚本,测试/smoke 专用)。
 *
 * 会话文件落在 JIDE 自己的目录(<runtimeRoot>/sessions),与 pi CLI 的目录隔离。
 * 每个工作区(按路径编码)一个子目录,M1 单会话。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	createEventJournal,
	type EventJournal,
	type HostEvent,
	type SessionStatus,
} from "@jide/contracts";
import type { AgentEngine, EngineEvent } from "./agent-engine";
import { DemoEngine } from "./demo-engine";
import { PiSession, memoryFilePath } from "./pi-session";
import type { ToolBridgeServer } from "./bridge-server";

export interface SessionEntry {
	sessionId: string;
	engine: AgentEngine;
	sessionFilePath: string;
	cwd: string;
	modelLabel: string;
	/** 仅测试/smoke 路径为 true(脚本引擎重建保真用) */
	demo?: boolean;
	/** 真实路径重建时需复刻的注入文本(pi 侧经 jide-memory 扩展读取) */
	memoryContext?: string;
	/** 会话所属工作区(工具桥按此路由宿主服务);未解析到工作区时缺省 */
	workspaceId?: string;
	/** 会话启动模型(--model provider/id);缺省 = pi 自己的默认 */
	model?: { provider: string; modelId: string };
	/** 编排模式(P2):注入 jide-orchestrator 扩展(委派工具),会话即 Router */
	orchestrator?: boolean;
	status: SessionStatus;
	unsubscribe: () => void;
}

export interface CreateSessionOptions {
	workspacePath: string;
	/** 仅测试/smoke:进程内脚本引擎(demo-engine.ts);产品路径恒为真实模式 */
	demoMode?: boolean;
	/** 三级注入文本(M4):真实模式经 <会话目录>/.jide-memory.md + jide-memory 扩展进 systemPrompt */
	memoryContext?: string;
	/** 工具桥路由键(工作区 id);由 index.ts 在 session.create 时反查传入 */
	workspaceId?: string;
	/** 新会话模型(settings.defaultModel 解析后传入);空 = pi 默认 */
	model?: { provider: string; modelId: string };
	/** 编排模式(P2):注入 jide-orchestrator 扩展(委派工具),会话即 Router */
	orchestrator?: boolean;
	/**
	 * 兼容保留:真实模式下工作区 AGENTS.md 由 pi 原生发现加载(自己的 pi 自己读)。
	 */
	agentsMd?: string | null;
}

export type EmitFn = (event: HostEvent) => void;

const HOST_NAME = "jide-host/0.1.0";

export class AgentHost {
	private sessions = new Map<string, SessionEntry>();
	private journal: EventJournal = createEventJournal();
	private emit: EmitFn = () => {};
	/** 工具桥(pi 扩展回环调宿主服务);未绑定时 pi 侧不注册 jide-tools 扩展 */
	private bridge: ToolBridgeServer | null = null;
	/** 会话 settled 一次性监听(自动化运行引擎等外部等待者) */
	private settledListeners = new Map<string, Set<() => void>>();

	constructor(private runtimeRoot: string = process.env.JIDE_HOME ?? join(process.cwd(), "runtime")) {}

	/** 注入事件出口(由 index.ts 接到 RPC 推送) */
	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	/** 注入工具桥(index.ts 持有并注册处理器;真实会话 spawn 时下发 -e 与桥 env) */
	bindBridge(bridge: ToolBridgeServer) {
		this.bridge = bridge;
	}

	/** 订阅某会话的下一次 settled(一次性,触发即自动退订);返回退订函数 */
	onSettled(sessionId: string, cb: () => void): () => void {
		let set = this.settledListeners.get(sessionId);
		if (!set) {
			set = new Set();
			this.settledListeners.set(sessionId, set);
		}
		set.add(cb);
		return () => {
			set!.delete(cb);
			if (!set!.size) this.settledListeners.delete(sessionId);
		};
	}

	private fireSettled(sessionId: string) {
		const set = this.settledListeners.get(sessionId);
		if (!set) return;
		this.settledListeners.delete(sessionId);
		for (const cb of set) {
			try {
				cb();
			} catch {
				/* 监听者异常不影响事件流 */
			}
		}
	}

	lastSeq() {
		return this.journal.lastSeq();
	}

	eventsSince(afterSeq: number): HostEvent[] {
		return this.journal.since(afterSeq);
	}

	private push(event: Omit<HostEvent, "seq">) {
		const withSeq = this.journal.append(event);
		this.emit(withSeq);
	}

	log(level: "info" | "warn" | "error", message: string) {
		this.push({ type: "host.log", level, message });
	}

	private sessionDir(cwd: string) {
		const encoded = cwd.replace(/[^a-zA-Z0-9_-]+/g, "--");
		const dir = join(this.runtimeRoot, "sessions", encoded);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	/**
	 * pi 进程内扩展目录(jide-guard / jide-memory / jide-tools)。这些 .ts 由 pi 的
	 * jiti 加载,不进 JIDE bundle;构建时经 electrobun.config copy 到包根 jide-extensions/。
	 */
	private extensionsDir(): string | null {
		const candidates = [
			join(import.meta.dir, "jide-extensions"),
			join(import.meta.dir, "..", "jide-extensions"),
			join(import.meta.dir, "..", "..", "jide-extensions"),
			join(process.cwd(), "src", "bun", "host", "extensions"),
		];
		for (const dir of candidates) {
			if (existsSync(join(dir, "jide-guard.ts"))) return dir;
		}
		return null;
	}

	/** 组装 pi 子进程的扩展参数(-e 门禁/记忆扩展;绑定了桥再带工具桥;编排会话再加委派工具) */
	private piExtensionArgs(orchestrator?: boolean): string[] {
		const extDir = this.extensionsDir();
		if (!extDir) {
			this.log("warn", "未找到 JIDE 扩展目录:危险命令门禁、记忆注入与工具桥不可用");
			return [];
		}
		const args = ["-e", join(extDir, "jide-guard.ts"), "-e", join(extDir, "jide-memory.ts")];
		if (this.bridge) args.push("-e", join(extDir, "jide-tools.ts"));
		if (orchestrator && this.bridge) args.push("-e", join(extDir, "jide-orchestrator.ts"));
		return args;
	}

	/** 工具桥 env:桥未绑定/未启动返回空;供 pi 进程内 jide-tools 扩展回环调用 */
	private bridgeEnv(workspaceId?: string): Record<string, string> {
		if (!this.bridge) return {};
		const ep = this.bridge.start();
		if (!ep) return {};
		return {
			JIDE_BRIDGE_URL: ep.url,
			JIDE_BRIDGE_TOKEN: ep.token,
			...(workspaceId ? { JIDE_WORKSPACE_ID: workspaceId } : {}),
		};
	}

	private setStatus(entry: SessionEntry, status: SessionStatus, detail?: string) {
		entry.status = status;
		this.push({ type: "session.status", sessionId: entry.sessionId, status, detail });
	}

	/** 引擎事件 → HostEvent 翻译(两引擎同构,零分支) */
	private wireEvents(entry: SessionEntry) {
		return entry.engine.onEvent((event: EngineEvent) => {
			switch (event.type) {
				case "agent_start":
					this.push({ type: "agent.started", sessionId: entry.sessionId });
					this.setStatus(entry, "busy");
					break;
				case "message_update": {
					const ame = (event as any).assistantMessageEvent;
					if (ame?.type === "text_delta" && typeof ame.delta === "string") {
						this.push({
							type: "agent.text-delta",
							sessionId: entry.sessionId,
							delta: ame.delta,
						});
					}
					break;
				}
				case "message_end": {
					const msg = (event as any).message;
					if (msg?.role === "assistant") {
						const text = this.extractText(msg.content);
						if (text) {
							this.push({
								type: "agent.message",
								sessionId: entry.sessionId,
								role: "assistant",
								text,
							});
						}
					}
					break;
				}
				case "tool_execution_start":
					this.push({
						type: "agent.tool",
						sessionId: entry.sessionId,
						phase: "start",
						toolName: (event as any).toolName ?? "unknown",
					});
					break;
				case "tool_execution_end":
					this.push({
						type: "agent.tool",
						sessionId: entry.sessionId,
						phase: "end",
						toolName: (event as any).toolName ?? "unknown",
						isError: Boolean((event as any).isError),
					});
					break;
				case "agent_settled":
					this.push({ type: "agent.settled", sessionId: entry.sessionId });
					this.fireSettled(entry.sessionId);
					if (entry.status === "busy" || entry.status === "aborted") {
						this.setStatus(
							entry,
							entry.status === "aborted" ? "aborted" : "idle",
						);
					}
					break;
				case "extension_ui_request": {
					// RPC Extension UI 子协议 → UI 呈现(session.respondUI 回写)
					const req = (event as any).request ?? {};
					this.push({
						type: "agent.ui.request",
						sessionId: entry.sessionId,
						requestId: String(req.id ?? ""),
						method: req.method ?? "notify",
						...(req.title !== undefined ? { title: String(req.title) } : {}),
						...(req.options !== undefined ? { options: req.options.map(String) } : {}),
						...(req.message !== undefined ? { message: String(req.message) } : {}),
						...(req.placeholder !== undefined ? { prefill: String(req.placeholder) } : {}),
						...(req.prefill !== undefined ? { prefill: String(req.prefill) } : {}),
						...(req.notifyType !== undefined ? { notifyType: req.notifyType } : {}),
						...(req.timeout !== undefined ? { timeout: Number(req.timeout) } : {}),
					});
					break;
				}
				default:
					break;
			}
		});
	}

	private extractText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((b: any) => b?.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("");
		}
		return "";
	}

	/** 写记忆注入文件并返回其路径(空文本返回 undefined) */
	private writeMemoryFile(dir: string, memoryContext?: string): string | undefined {
		if (!memoryContext?.trim()) return undefined;
		const p = memoryFilePath(dir);
		writeFileSync(p, memoryContext, "utf8");
		return p;
	}

	private async createEngine(opts: {
		cwd: string;
		dir: string;
		demo?: boolean;
		memoryContext?: string;
		sessionFile?: string;
		workspaceId?: string;
		model?: { provider: string; modelId: string };
		orchestrator?: boolean;
	}): Promise<AgentEngine> {
		if (opts.demo) {
			return new DemoEngine({ cwd: opts.cwd, sessionDir: opts.dir, sessionFile: opts.sessionFile });
		}
		const args = this.piExtensionArgs(opts.orchestrator);
		const memoryFile = this.writeMemoryFile(opts.dir, opts.memoryContext);
		return PiSession.create({
			cwd: opts.cwd,
			sessionDir: opts.dir,
			args,
			model: opts.model,
			env: {
				...(memoryFile ? { JIDE_MEMORY_FILE: memoryFile } : {}),
				...(opts.orchestrator ? { JIDE_ORCH: "1" } : {}),
				...this.bridgeEnv(opts.workspaceId),
			},
			sessionFile: opts.sessionFile,
			onLog: (level, message) => this.log(level, message),
		});
	}

	async createSession(opts: CreateSessionOptions) {
		const cwd = opts.workspacePath || process.cwd();
		const dir = this.sessionDir(cwd);

		const engine = await this.createEngine({
			cwd,
			dir,
			demo: opts.demoMode,
			memoryContext: opts.memoryContext,
			workspaceId: opts.workspaceId,
			model: opts.model,
			orchestrator: opts.orchestrator,
		});

		const entry: SessionEntry = {
			sessionId: engine.sessionId,
			engine,
			sessionFilePath: engine.sessionFilePath,
			cwd,
			modelLabel: engine.modelLabel,
			demo: opts.demoMode,
			memoryContext: opts.memoryContext,
			workspaceId: opts.workspaceId,
			model: opts.model,
			orchestrator: opts.orchestrator,
			status: "idle",
			unsubscribe: () => {},
		};
		entry.unsubscribe = this.wireEvents(entry);
		this.sessions.set(entry.sessionId, entry);

		this.push({
			type: "session.created",
			sessionId: entry.sessionId,
			modelLabel: entry.modelLabel,
		});
		this.log(
			"info",
			`会话已创建:${entry.sessionId.slice(0, 8)} · ${entry.modelLabel} · ${relative(process.cwd(), dir) || dir}`,
		);
		return entry;
	}

	getSession(sessionId: string): SessionEntry | undefined {
		return this.sessions.get(sessionId);
	}

	getSnapshot(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return undefined;
		const messages = entry.engine.snapshotMessages();
		return {
			sessionId: entry.sessionId,
			status: entry.status,
			messages,
			modelLabel: entry.modelLabel,
		};
	}

	async prompt(sessionId: string, text: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		if (entry.status === "disposed") throw new Error("会话已销毁,请先重建");
		if (entry.status === "busy") throw new Error("上一轮仍在运行,请等待完成或先中断");
		this.push({ type: "agent.message", sessionId, role: "user", text });
		// 真实模式:受理即返回,流式/完成走事件;演示模式:脚本播完即返回
		await entry.engine.prompt(text);
	}

	async abort(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		this.setStatus(entry, "aborted", "用户中断");
		await entry.engine.abort();
	}

	/** 定向给某会话插队(pi steer;忙闲语义由调用方把握) */
	async steerSession(sessionId: string, text: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		await entry.engine.steer(text);
	}

	/**
	 * 宿主推送式日志回喂:把运行中会话(agent busy)按工作区插队 steer。
	 * 返回送达的会话数;空闲会话不自动起轮(避免未经用户同意的 API 消耗),
	 * 由调用方决定空闲时的呈现(如 host.log 提示)。
	 */
	async steerBusyForWorkspace(workspaceId: string, text: string): Promise<number> {
		let pushed = 0;
		for (const entry of this.sessions.values()) {
			if (entry.workspaceId !== workspaceId) continue;
			if (entry.status !== "busy") continue;
			try {
				await entry.engine.steer(text);
				pushed++;
			} catch (err: any) {
				this.log("warn", `steer 未送达(${entry.sessionId.slice(0, 8)}):${err?.message ?? err}`);
			}
		}
		return pushed;
	}

	/** 工作区是否有关注中的会话(日志泵空闲提示用) */
	hasSessionForWorkspace(workspaceId: string): boolean {
		for (const entry of this.sessions.values()) {
			if (entry.workspaceId === workspaceId && entry.status !== "disposed") return true;
		}
		return false;
	}

	/** UI 回复 pi 扩展 UI 请求(agent.ui.request;仅 dialog 类需要) */
	respondUI(sessionId: string, resp: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		const engine = entry.engine as AgentEngine & {
			respondUI?: (r: typeof resp) => void;
		};
		if (typeof engine.respondUI !== "function") return; // demo 引擎无扩展 UI
		engine.respondUI(resp);
	}

	/** 切换活动会话模型(pi set_model 即时生效);成功后更新 modelLabel 并返回显示名 */
	async setModel(sessionId: string, provider: string, modelId: string): Promise<string> {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		const engine = entry.engine as AgentEngine & {
			setModel?: (provider: string, modelId: string) => Promise<string>;
		};
		if (typeof engine.setModel !== "function") throw new Error("当前引擎(演示模式)不支持切换模型");
		const label = await engine.setModel(provider, modelId);
		entry.modelLabel = label;
		entry.model = { provider, modelId };
		this.log("info", `会话 ${sessionId.slice(0, 8)} 已切换模型:${label}`);
		return label;
	}

	/** 销毁并从会话文件重建(恢复历史消息) */
	async rebuild(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		const { sessionFilePath, cwd, demo, memoryContext, workspaceId, model } = entry;

		entry.unsubscribe();
		await entry.engine.dispose();
		this.sessions.delete(sessionId);
		this.setStatus(entry, "disposed");

		const dir = this.sessionDir(cwd);
		const engine = await this.createEngine({
			cwd,
			dir,
			demo,
			memoryContext,
			sessionFile: sessionFilePath || undefined,
			workspaceId,
			model,
			orchestrator: entry.orchestrator,
		});

		const next: SessionEntry = {
			sessionId: engine.sessionId,
			engine,
			sessionFilePath: engine.sessionFilePath || sessionFilePath,
			cwd,
			modelLabel: entry.modelLabel,
			demo,
			memoryContext,
			workspaceId,
			model,
			orchestrator: entry.orchestrator,
			status: "idle",
			unsubscribe: () => {},
		};
		next.unsubscribe = this.wireEvents(next);
		this.sessions.set(next.sessionId, next);

		const restored = (await engine.messages()).length;
		this.push({
			type: "session.rebuilt",
			sessionId: next.sessionId,
			restoredMessages: restored,
		});
		return { entry: next, restored };
	}

	disposeAll() {
		for (const entry of this.sessions.values()) {
			entry.unsubscribe();
			try {
				void entry.engine.dispose();
			} catch {
				// 退出路径,忽略
			}
		}
		this.sessions.clear();
	}
}

export { HOST_NAME };
