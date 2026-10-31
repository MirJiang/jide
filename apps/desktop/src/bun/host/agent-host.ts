/**
 * AgentHost — 主进程内的 pi 会话宿主(business-design §7.1)
 *
 * 职责:
 *  - 管理 pi AgentSession 生命周期:创建 / prompt / 中断 / 重建 / 销毁;
 *  - 把 pi 的 AgentSessionEvent 流翻译为 @jide/contracts 的 HostEvent(带 seq,可回放);
 *  - demo 模式:Faux Provider 全链路本地演练(无网络、无密钥);
 *  - 真实模式:默认 ModelRuntime(读 ~/.pi 配置;后续接自定义 provider)。
 *
 * 会话文件落在 JIDE 自己的目录(<root>/runtime/sessions),与 pi CLI 的目录隔离。
 * 每个工作区(按路径编码)一个子目录,M1 单会话。
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createEventJournal,
	type EventJournal,
	type HostEvent,
	type SessionStatus,
} from "@jide/contracts";
import { createDemoRuntime } from "./demo-faux";

export interface SessionEntry {
	sessionId: string;
	session: AgentSession;
	sessionFilePath: string;
	cwd: string;
	modelLabel: string;
	demo: boolean;
	status: SessionStatus;
	unsubscribe: () => void;
}

export interface CreateSessionOptions {
	workspacePath: string;
	demoMode: boolean;
	/** 三级注入文本(M4);连同 AGENTS.md(只读)一并作为 context files */
	memoryContext?: string;
	agentsMd?: string | null;
	/** JIDE agent 工具(测试域/计划/记忆;见 agent-tools.ts) */
	customTools?: unknown[];
	/** 内联扩展(危险命令门禁等) */
	extensions?: unknown[];
}

export type EmitFn = (event: HostEvent) => void;

const HOST_NAME = "jide-host/0.1.0";

export class AgentHost {
	private sessions = new Map<string, SessionEntry>();
	private journal: EventJournal = createEventJournal();
	private emit: EmitFn = () => {};

	constructor(private runtimeRoot: string = process.env.JIDE_HOME ?? join(process.cwd(), "runtime")) {}

	/** 注入事件出口(由 index.ts 接到 RPC 推送) */
	bindEmitter(emit: EmitFn) {
		this.emit = emit;
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

	private setStatus(entry: SessionEntry, status: SessionStatus, detail?: string) {
		entry.status = status;
		this.push({ type: "session.status", sessionId: entry.sessionId, status, detail });
	}

	/** pi 事件 → HostEvent 翻译 */
	private wireEvents(entry: SessionEntry) {
		return entry.session.subscribe((event: AgentSessionEvent) => {
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
					if (entry.status === "busy" || entry.status === "aborted") {
						this.setStatus(
							entry,
							entry.status === "aborted" ? "aborted" : "idle",
						);
					}
					break;
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

	async createSession(opts: CreateSessionOptions) {
		const cwd = opts.workspacePath || process.cwd();
		const dir = this.sessionDir(cwd);

		const manager = SessionManager.create(cwd, dir);
		const contextFiles: Array<{ path: string; content: string }> = [];
		if (opts.agentsMd) contextFiles.push({ path: join(cwd, "AGENTS.md"), content: opts.agentsMd });
		if (opts.memoryContext) contextFiles.push({ path: "/virtual/.memory/inject.md", content: opts.memoryContext });
		const resourceLoader = contextFiles.length
			? new DefaultResourceLoader({
					cwd,
					agentDir: process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
					settingsManager: undefined as any,
					agentsFilesOverride: (base) => ({
						agentsFiles: [
							// AGENTS.md(用户手写,只读)保留在首位
							...base.agentsFiles.filter((f) => !f.path.endsWith("AGENTS.md") && !f.path.endsWith("CLAUDE.md")),
							...contextFiles,
						],
					}),
				} as any)
			: undefined;

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			sessionManager: manager,
			...(resourceLoader ? { resourceLoader } : {}),
			...(opts.customTools?.length ? { customTools: opts.customTools as any } : {}),
			...(opts.extensions?.length ? { extensions: opts.extensions as any } : {}),
			...(opts.demoMode ? await createDemoRuntime() : {}),
		});

		const entry: SessionEntry = {
			sessionId: manager.getSessionId(),
			session,
			sessionFilePath: manager.getSessionFile() ?? "",
			cwd,
			modelLabel: opts.demoMode ? "faux-demo(本地演练)" : (session as any).model?.name ?? "default",
			demo: opts.demoMode,
			status: "idle",
			unsubscribe: () => {},
		};
		entry.unsubscribe = this.wireEvents(entry);
		this.sessions.set(entry.sessionId, entry);

		this.push({
			type: "session.created",
			sessionId: entry.sessionId,
			modelLabel: entry.modelLabel,
			demo: entry.demo,
		});
		if (modelFallbackMessage) {
			this.log("warn", modelFallbackMessage);
		}
		this.log(
			"info",
			`会话已创建:${entry.sessionId.slice(0, 8)} · ${relative(process.cwd(), dir) || dir}`,
		);
		return entry;
	}

	getSession(sessionId: string): SessionEntry | undefined {
		return this.sessions.get(sessionId);
	}

	getSnapshot(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return undefined;
		const messages = (entry.session.state?.messages ?? [])
			.filter((m: any) => m?.role === "user" || m?.role === "assistant")
			.map((m: any) => ({
				role: m.role as "user" | "assistant",
				text: this.extractText(m.content) || (m.content ?? ""),
			}));
		return {
			sessionId: entry.sessionId,
			status: entry.status,
			messages,
			modelLabel: entry.modelLabel,
			demo: entry.demo,
		};
	}

	async prompt(sessionId: string, text: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		if (entry.status === "disposed") throw new Error("会话已销毁,请先重建");
		this.push({ type: "agent.message", sessionId, role: "user", text });
		// prompt 解析的是整轮事件流;异常向上抛给 RPC 层转为 ok:false
		await entry.session.prompt(text);
	}

	async abort(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		this.setStatus(entry, "aborted", "用户中断");
		await entry.session.abort();
	}

	/** 销毁并从会话文件重建(恢复历史消息) */
	async rebuild(sessionId: string) {
		const entry = this.sessions.get(sessionId);
		if (!entry) throw new Error(`会话不存在:${sessionId}`);
		const { sessionFilePath, cwd, demo } = entry;

		console.log("[jide:rebuild] 1 unsubscribe");
		entry.unsubscribe();
		console.log("[jide:rebuild] 2 dispose");
		entry.session.dispose();
		console.log("[jide:rebuild] 3 disposed ok");
		this.sessions.delete(sessionId);
		this.setStatus(entry, "disposed");

		const dir = this.sessionDir(cwd);
		console.log(`[jide:rebuild] 4 open file=${sessionFilePath}`);
		const manager = sessionFilePath
			? SessionManager.open(sessionFilePath, dir)
			: SessionManager.create(cwd, dir);
		console.log("[jide:rebuild] 5 open ok");
		const { session } = await createAgentSession({
			cwd,
			sessionManager: manager,
			...(demo ? await createDemoRuntime() : {}),
		});

		const next: SessionEntry = {
			sessionId: manager.getSessionId(),
			session,
			sessionFilePath: manager.getSessionFile() ?? sessionFilePath,
			cwd,
			modelLabel: entry.modelLabel,
			demo,
			status: "idle",
			unsubscribe: () => {},
		};
		next.unsubscribe = this.wireEvents(next);
		this.sessions.set(next.sessionId, next);

		const restored = (session.state?.messages ?? []).length;
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
				entry.session.dispose();
			} catch {
				// 退出路径,忽略
			}
		}
		this.sessions.clear();
	}
}

export { HOST_NAME };
