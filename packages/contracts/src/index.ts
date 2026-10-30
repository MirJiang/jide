/**
 * @jide/contracts — JIDE 壳(UI)/ 宿主(主进程)之间的类型化协议
 *
 * 协议三原则(business-design §7.2):
 *  1. 可枚举 —— 全部请求与事件在本文件中全量声明,无隐式通道;
 *  2. 可演化 —— PROTOCOL_VERSION 单调递增;app.hello 做版本协商,不兼容即拒绝;
 *  3. 可回放 —— Host→UI 的一切推送都是带 seq 的 HostEvent,事件流即日志。
 *
 * 本包零依赖、纯类型 + 轻量运行时守卫,壳与宿主两侧共同引用。
 */

/** 协议版本。破坏性变更(删改已有字段语义)时 +1,并在 app.hello 协商。 */
export const PROTOCOL_VERSION = 1 as const;

/** 会话运行状态 */
export type SessionStatus =
	| "idle" // 已创建/空闲
	| "busy" // agent 主循环进行中
	| "aborted" // 被用户中断
	| "error" // 出错(见 detail)
	| "disposed"; // 已销毁,等待重建

/* ------------------------------------------------------------------ */
/* UI → 宿主:请求(全部枚举)                                        */
/* ------------------------------------------------------------------ */

export interface HostRequestShapes {
	/** 版本协商与宿主信息。连接后 UI 必须首先调用。 */
	"app.hello": {
		params: { protocolVersion: number };
		response:
			| { ok: true; protocolVersion: number; host: string; demo: boolean }
			| { ok: false; error: string; expectedProtocolVersion: number };
	};
	/** 创建 agent 会话(一个工作区一个活动会话;M1 单会话) */
	"session.create": {
		params: { workspacePath: string; demoMode: boolean };
		response:
			| { ok: true; sessionId: string; modelLabel: string; demo: boolean }
			| { ok: false; error: string };
	};
	/** 发送一条用户消息并驱动 agent 主循环 */
	"session.prompt": {
		params: { sessionId: string; text: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 中断当前进行中的 agent 循环(abort + 等待 idle) */
	"session.abort": {
		params: { sessionId: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 销毁并重建会话(崩溃恢复后手;从会话文件恢复历史) */
	"session.rebuild": {
		params: { sessionId: string };
		response:
			| { ok: true; sessionId: string; restoredMessages: number }
			| { ok: false; error: string };
	};
	/** 读取会话当前状态(启动时 UI 恢复用) */
	"session.get": {
		params: { sessionId: string };
		response:
			| {
					ok: true;
					sessionId: string;
					status: SessionStatus;
					messages: Array<{ role: "user" | "assistant"; text: string }>;
					modelLabel: string;
					demo: boolean;
			  }
			| { ok: false; error: string };
	};
}

export type HostRequestMethod = keyof HostRequestShapes;
export type HostRequestParams<M extends HostRequestMethod> =
	HostRequestShapes[M]["params"];
export type HostRequestResponse<M extends HostRequestMethod> =
	HostRequestShapes[M]["response"];

/** 宿主侧注册的请求处理器形状 */
export type HostRequestHandlers = {
	[M in HostRequestMethod]: (
		params: HostRequestParams<M>,
	) => Promise<HostRequestResponse<M>> | HostRequestResponse<M>;
};

/* ------------------------------------------------------------------ */
/* 宿主 → UI:事件(单通道 "event",带 seq,即日志)                  */
/* ------------------------------------------------------------------ */

export type HostEvent =
	| {
			type: "session.created";
			seq: number;
			sessionId: string;
			modelLabel: string;
			demo: boolean;
	  }
	| { type: "session.status"; seq: number; sessionId: string; status: SessionStatus; detail?: string }
	| { type: "agent.started"; seq: number; sessionId: string }
	| { type: "agent.text-delta"; seq: number; sessionId: string; delta: string }
	| {
			type: "agent.message";
			seq: number;
			sessionId: string;
			role: "user" | "assistant";
			text: string;
	  }
	| {
			type: "agent.tool";
			seq: number;
			sessionId: string;
			phase: "start" | "end";
			toolName: string;
			isError?: boolean;
			summary?: string;
	  }
	| { type: "agent.settled"; seq: number; sessionId: string }
	| { type: "session.rebuilt"; seq: number; sessionId: string; restoredMessages: number }
	| { type: "host.log"; seq: number; level: "info" | "warn" | "error"; message: string };

export type HostEventType = HostEvent["type"];

/** 事件日志(journal):宿主持有,UI 崩溃重连后按 lastSeq 增量补发 = 可回放 */
export interface EventJournal {
	/** 目前已分配的最大 seq */
	lastSeq(): number;
	/** 取 (afterSeq, ...] 区间的事件 */
	since(afterSeq: number): HostEvent[];
	/** 追加事件并分配 seq */
	append(event: Omit<HostEvent, "seq">): HostEvent;
}

/** 创建进程内事件日志(环形缓冲,保留最近 maxEntries 条) */
export function createEventJournal(maxEntries = 10_000): EventJournal {
	const entries: HostEvent[] = [];
	let seq = 0;
	return {
		lastSeq: () => seq,
		since: (afterSeq) => entries.filter((e) => e.seq > afterSeq),
		append(event) {
			const withSeq = { ...event, seq: ++seq } as HostEvent;
			entries.push(withSeq);
			if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
			return withSeq;
		},
	};
}

/* ------------------------------------------------------------------ */
/* 运行时守卫(收包侧做最低限度校验)                                 */
/* ------------------------------------------------------------------ */

const EVENT_TYPES: ReadonlySet<string> = new Set<HostEventType>([
	"session.created",
	"session.status",
	"agent.started",
	"agent.text-delta",
	"agent.message",
	"agent.tool",
	"agent.settled",
	"session.rebuilt",
	"host.log",
]);

export function isHostEvent(value: unknown): value is HostEvent {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.type === "string" && EVENT_TYPES.has(v.type) && typeof v.seq === "number";
}

/** UI 侧事件分发器 */
export type HostEventHandler = (event: HostEvent) => void;
