/**
 * AgentEngine — AgentHost 之下的引擎缝(§7.1)
 *
 * UI/HostEvent 契约不变;引擎二实现:
 *  - PiSession:本机 pi CLI 子进程(--mode rpc),产品路径;
 *  - DemoEngine:进程内脚本合成,测试/smoke 离线演练,不依赖任何 pi 包。
 *
 * EngineEvent 刻意沿用 pi 会话事件子集的形状(agent_start / message_update /
 * message_end / tool_execution_start / tool_execution_end / agent_settled),
 * 两个引擎产出同构事件,AgentHost 的翻译层零分支。
 */

export interface EngineEvent {
	type:
		| "agent_start"
		| "message_update"
		| "message_end"
		| "tool_execution_start"
		| "tool_execution_end"
		| "agent_settled"
		/** pi 扩展 UI 请求透传(RPC Extension UI 子协议;record 原样在 .request) */
		| "extension_ui_request";
	[key: string]: any;
}

export interface EngineMessage {
	role: "user" | "assistant";
	text: string;
}

export interface AgentEngine {
	kind: "demo" | "pi";
	sessionId: string;
	sessionFilePath: string;
	modelLabel: string;
	/** 引擎事件流;返回退订函数 */
	onEvent(cb: (event: EngineEvent) => void): () => void;
	/** 发送用户输入。真实模式:受理即返回,流式与完成走事件 */
	prompt(text: string): Promise<void>;
	/** 插队消息(pi steer):仅在 agent 运行中有意义,于当前轮工具执行后、下次模型调用前送达 */
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	/** 同步快照(引擎内部缓存),供 session.get */
	snapshotMessages(): EngineMessage[];
	/** 权威消息列表(重建恢复计数用) */
	messages(): Promise<EngineMessage[]>;
	dispose(): Promise<void>;
}

/** 从 pi 消息 content(string | 内容块数组)提取纯文本 */
export function extractEngineText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("");
	}
	return "";
}

/** pi AgentMessage(role/content)→ EngineMessage;非对话角色过滤 */
export function toEngineMessages(messages: any[]): EngineMessage[] {
	const out: EngineMessage[] = [];
	for (const m of messages ?? []) {
		if (m?.role !== "user" && m?.role !== "assistant") continue;
		const text = extractEngineText(m.content) || (typeof m.content === "string" ? m.content : "");
		if (text) out.push({ role: m.role, text });
	}
	return out;
}
