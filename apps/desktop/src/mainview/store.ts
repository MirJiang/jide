/**
 * UI 状态(zustand)—— M1:单会话聊天
 * 状态三分原则(business-design §7.3):这里全部是可弃的 UI 态;
 * 会话态由 pi 持有,项目态在文件/git。
 */

import { create } from "zustand";
import type { HostEvent, SessionStatus } from "@jide/contracts";
import type { JideClient } from "./rpc";

export interface ChatMessage {
	id: number;
	role: "user" | "assistant";
	text: string;
	/** 工具调用行(简版展示) */
	tool?: string;
	toolError?: boolean;
}

interface JideStore {
	connected: boolean;
	protocolVersion: number | null;
	hostName: string;
	demo: boolean;
	sessionId: string | null;
	modelLabel: string;
	status: SessionStatus;
	messages: ChatMessage[];
	/** 流式中的未定稿文本 */
	streaming: string;
	logs: string[];
	lastSeq: number;
	client: JideClient | null;

	connect(client: JideClient): Promise<void>;
	send(text: string): Promise<void>;
	abort(): Promise<void>;
	rebuild(): Promise<void>;
	handleEvent(event: HostEvent): void;
}

let nextMsgId = 1;

export const useJide = create<JideStore>((set, get) => ({
	connected: false,
	protocolVersion: null,
	hostName: "",
	demo: false,
	sessionId: null,
	modelLabel: "",
	status: "idle",
	messages: [],
	streaming: "",
	logs: [],
	lastSeq: 0,
	client: null,

	async connect(client) {
		set({ client });
		const hello = await client.request("app.hello", {
			protocolVersion: 1,
		});
		if (!hello.ok) {
			set({ logs: [...get().logs, `协议协商失败:${hello.error}`] });
			return;
		}
		set({
			connected: true,
			protocolVersion: hello.protocolVersion,
			hostName: hello.host,
			demo: hello.demo,
		});
		// M1:启动即创建会话(工作区 = 当前目录;demo 默认)
		const created = await client.request("session.create", {
			workspacePath: "",
			demoMode: hello.demo,
		});
		if (created.ok) {
			set({ sessionId: created.sessionId, modelLabel: created.modelLabel });
		} else {
			set({ logs: [...get().logs, `会话创建失败:${created.error}`] });
		}
	},

	async send(text) {
		const { client, sessionId } = get();
		if (!client || !sessionId || !text.trim()) return;
		set((s) => ({
			messages: [
				...s.messages,
				{ id: nextMsgId++, role: "user", text: text.trim() },
			],
		}));
		const r = await client.request("session.prompt", { sessionId, text });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `发送失败:${r.error}`] }));
		}
	},

	async abort() {
		const { client, sessionId } = get();
		if (!client || !sessionId) return;
		const r = await client.request("session.abort", { sessionId });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `停止失败:${r.error}`] }));
	},

	async rebuild() {
		const { client, sessionId } = get();
		if (!client || !sessionId) return;
		// 重建后 sessionId 可能变化;成功后拉快照恢复消息列表
		const r = await client.request("session.rebuild", { sessionId });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `重建失败:${r.error}`] }));
			return;
		}
		const snap = await client.request("session.get", { sessionId: r.sessionId });
		if (snap.ok) {
			set({
				sessionId: snap.sessionId,
				status: snap.status,
				messages: snap.messages.map((m) => ({ id: nextMsgId++, ...m })),
				streaming: "",
				modelLabel: snap.modelLabel,
				demo: snap.demo,
			});
		}
	},

	handleEvent(event) {
		set({ lastSeq: event.seq });
		switch (event.type) {
			case "session.created":
				set({ sessionId: event.sessionId, modelLabel: event.modelLabel, demo: event.demo });
				break;
			case "session.status":
				set({ status: event.status });
				break;
			case "agent.text-delta":
				set((s) => ({ streaming: s.streaming + event.delta }));
				break;
			case "agent.message":
				if (event.role === "assistant") {
					set((s) => ({
						messages: [
							...s.messages,
							{ id: nextMsgId++, role: "assistant", text: event.text },
						],
						streaming: "",
					}));
				}
				break;
			case "agent.tool":
				set((s) => ({
					messages: [
						...s.messages,
						{
							id: nextMsgId++,
							role: "assistant",
							text: event.phase === "start" ? `调用工具 ${event.toolName} …` : `工具 ${event.toolName} 完成${event.isError ? "(出错)" : ""}`,
							tool: event.toolName,
							toolError: event.isError,
						},
					],
				}));
				break;
			case "session.rebuilt":
				set((s) => ({ logs: [...s.logs, `会话已重建,恢复 ${event.restoredMessages} 条历史`] }));
				break;
			case "host.log":
				set((s) => ({ logs: [...s.logs, `[${event.level}] ${event.message}`] }));
				break;
			default:
				break;
		}
	},
}));
