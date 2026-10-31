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

	/* ---------------- 工作区域(W1-W4) ---------------- */

	/** 打开/注册项目(信任门前置检查:是否 git 仓库、是否已信任) */
	"project.open": {
		params: { path: string };
		response:
			| {
					ok: true;
					projectId: string;
					root: string;
					name: string;
					trusted: boolean;
					isRepo: boolean;
					branch: string | null;
			  }
			| { ok: false; error: string };
	};
	/** 信任门:显式信任该项目(W1) */
	"project.trust": {
		params: { projectId: string };
		response: { ok: true; trusted: boolean } | { ok: false; error: string };
	};
	/** 列出项目的工作区(Default + worktrees) */
	"workspace.list": {
		params: { projectId: string };
		response:
			| {
					ok: true;
					activeWorkspaceId: string | null;
					workspaces: Array<{
						id: string;
						kind: "default" | "worktree";
						branch: string;
						path: string;
						baseRef?: string;
					}>;
			  }
			| { ok: false; error: string };
	};
	/** 创建隔离工作区(worktree,W3)。仅已信任项目。 */
	"workspace.create": {
		params: { projectId: string; name: string; fromRef?: string };
		response:
			| { ok: true; workspaceId: string; path: string; branch: string }
			| { ok: false; error: string };
	};
	/** 原子切换工作区(W4):会话/终端等上下文整套换入换出 */
	"workspace.switch": {
		params: { projectId: string; workspaceId: string };
		response: { ok: true; activeWorkspaceId: string } | { ok: false; error: string };
	};

	/* ---------------- 文件域(编辑器后端) ---------------- */

	"fs.list": {
		params: { workspaceId: string; relPath: string };
		response:
			| { ok: true; entries: Array<{ name: string; kind: "file" | "dir" }> }
			| { ok: false; error: string };
	};
	"fs.read": {
		params: { workspaceId: string; relPath: string };
		response:
			| { ok: true; content: string; size: number }
			| { ok: false; error: string };
	};
	"fs.write": {
		params: { workspaceId: string; relPath: string; content: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/* ---------------- 终端域(M2 基面) ---------------- */

	"terminal.create": {
		params: { workspaceId: string; cwd?: string };
		response:
			| { ok: true; terminalId: string }
			| { ok: false; error: string };
	};
	"terminal.write": {
		params: { terminalId: string; data: string };
		response: { ok: true } | { ok: false; error: string };
	};
	"terminal.resize": {
		params: { terminalId: string; cols: number; rows: number };
		response: { ok: true } | { ok: false; error: string };
	};
	"terminal.dispose": {
		params: { terminalId: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/* ---------------- 计划域(W5) ---------------- */

	"plan.create": {
		params: { workspaceId: string; goal: string; steps: string[] };
		response:
			| { ok: true; planId: string }
			| { ok: false; error: string };
	};
	/** 标记步骤完成;隔离工作区触发自动提交(W5),Default 拒绝 */
	"plan.stepDone": {
		params: { planId: string; stepIndex: number };
		response:
			| { ok: true; commit?: { sha: string; message: string } }
			| { ok: false; error: string };
	};
	/** 查询工作区当前进行中的计划(工作区切换时恢复上下文用) */
	"plan.get": {
		params: { workspaceId: string };
		response:
			| {
					ok: true;
					plan:
						| {
								planId: string;
								goal: string;
								steps: Array<{ text: string; state: "pending" | "doing" | "done"; commit?: string }>;
						  }
						| null;
			  }
			| { ok: false; error: string };
	};

	/* ---------------- Git 呈现 ---------------- */

	"git.status": {
		params: { workspaceId: string };
		response:
			| {
					ok: true;
					branch: string;
					changes: Array<{ path: string; staged: boolean; kind: "M" | "A" | "D" | "?" }>;
					ahead: number;
					behind: number;
			  }
			| { ok: false; error: string };
	};
	"git.log": {
		params: { workspaceId: string; limit?: number };
		response:
			| {
					ok: true;
					commits: Array<{
						sha: string;
						shortSha: string;
						message: string;
						author: string;
						date: string;
						refs: string[];
						isAgent: boolean;
					}>;
			  }
			| { ok: false; error: string };
	};

	/* ---------------- 测试域 M3(4A-4F) ---------------- */

	/** dev server 生命周期(工作区持有;agent 与内嵌预览共享同一实例) */
	"devserver.ensure": {
		params: {
			workspaceId: string;
			/** 启动命令;未传则用项目已保存的配置 */
			command?: string;
			cwd?: string;
			port?: number;
			/** 探测模式:auto(默认)/ http / port / log */
			probe?: "auto" | "http" | "port" | "log";
			/** 日志特征(log 模式用,如 "ready in") */
			readyPattern?: string;
		};
		response:
			| {
					ok: true;
					url: string;
					port: number;
					probeMode: string;
					startedMs: number;
			  }
			| { ok: false; error: string; logTail?: string };
	};
	"devserver.stop": {
		params: { workspaceId: string };
		response: { ok: true } | { ok: false; error: string };
	};
	"devserver.status": {
		params: { workspaceId: string };
		response: {
			ok: true;
			state: "stopped" | "starting" | "ready" | "crashed";
			url: string | null;
			probeMode: string;
		};
	};

	/** HTTP 探测(4B):URL + 期望(状态码/包含文本/JSON 路径) */
	"probe.http": {
		params: {
			url: string;
			expectStatus?: number;
			contains?: string;
			jsonPath?: string;
			jsonEquals?: string;
		};
		response:
			| { ok: true; passed: boolean; actual: string; detail?: string }
			| { ok: false; error: string };
	};

	/** 智能选测(4D):scope=diff 映射关联用例子集;all 全量 */
	"test.run": {
		params: { workspaceId: string; scope: "diff" | "all" | "files"; files?: string[] };
		response:
			| {
					ok: true;
					selected: number;
					total: number;
					durationMs: number;
					results: Array<{
						name: string;
						file: string;
						status: "pass" | "fail" | "skip";
						durationMs: number;
						message?: string;
					}>;
			  }
			| { ok: false; error: string };
	};

	/** 检查项(4E):项目资产(.jide/checks/)+ 临时 */
	"checks.list": {
		params: { workspaceId: string };
		response:
			| {
					ok: true;
					checks: Array<{
						id: string;
						title: string;
						kind: "asset" | "temp";
						/** 断言类型:http / browser / manual */
						assertion:
							| { type: "http"; url: string; expectStatus?: number; contains?: string }
							| { type: "browser"; url: string; clickSelector?: string; expectContains?: string }
							| { type: "manual"; note?: string };
						/** diff 命中自动带上的路径模式 */
						appliesTo?: string[];
						lastResult?: { passed: boolean; at: string; evidence?: string };
					}>;
			  }
			| { ok: false; error: string };
	};
	"checks.create": {
		params: {
			workspaceId: string;
			title: string;
			kind: "asset" | "temp";
			assertion: {
				type: "http" | "browser" | "manual";
				url?: string;
				expectStatus?: number;
				contains?: string;
				clickSelector?: string;
				expectContains?: string;
				note?: string;
			};
			appliesTo?: string[];
		};
		response: { ok: true; id: string } | { ok: false; error: string };
	};
	"checks.run": {
		params: { workspaceId: string; ids?: string[] };
		response:
			| {
					ok: true;
					results: Array<{ id: string; title: string; passed: boolean; detail?: string; evidence?: string }>;
			  }
			| { ok: false; error: string };
	};
	"checks.delete": {
		params: { workspaceId: string; id: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/** 浏览器自动化(4C):navigate/click/fill/capture(截图回传) */
	"browser.navigate": {
		params: { workspaceId: string; url: string };
		response: { ok: true; title: string } | { ok: false; error: string };
	};
	"browser.click": {
		params: { workspaceId: string; selector: string };
		response: { ok: true } | { ok: false; error: string };
	};
	"browser.capture": {
		params: { workspaceId: string; kind: "shot" };
		response:
			| { ok: true; /** base64 PNG */ dataBase64: string; path: string }
			| { ok: false; error: string };
	};
	"browser.hover": {
		params: { workspaceId: string; selector: string };
		response: { ok: true } | { ok: false; error: string };
	};
	"browser.scroll": {
		params: { workspaceId: string; x: number; y: number; selector?: string };
		response: { ok: true } | { ok: false; error: string };
	};
	"browser.snapshot": {
		params: { workspaceId: string };
		response:
			| { ok: true; outline: string }
			| { ok: false; error: string };
	};
	"browser.console": {
		params: { workspaceId: string; limit?: number };
		response:
			| { ok: true; messages: string[] }
			| { ok: false; error: string };
	};
	"browser.record": {
		params: { workspaceId: string; ms: number; intervalMs?: number };
		response:
			| { ok: true; frames: number; dir: string }
			| { ok: false; error: string };
	};

	/** 运行三档(4F)①:Agent 自测 = 后台跑 选测+检查项 */
	"run.agentSelfTest": {
		params: { workspaceId: string };
		response: { ok: true; summary: string } | { ok: false; error: string };
	};

	/** 评审队列(W6):自动提交等产出的人工门禁 */
	"review.list": {
		params: { projectId: string };
		response:
			| {
					ok: true;
					items: Array<{
						id: string;
						kind: "commit" | "memory" | "checks";
						title: string;
						detail: string;
						/** commit 型:来源工作区与分支 */
						workspaceId?: string;
						branch?: string;
						state: "pending" | "approved" | "asked" | "ignored";
					}>;
			  }
			| { ok: false; error: string };
	};
	"review.decide": {
		params: { id: string; decision: "approve" | "ask" | "ignore"; note?: string };
		response:
			| { ok: true; merged?: { sha: string; message: string } }
			| { ok: false; error: string };
	};

	/** 人侧预览(4F ②):打开内嵌预览窗口(dev server URL,与 agent 共引擎) */
	"preview.open": {
		params: { url: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/* ---------------- 记忆域 M4(§5) ---------------- */

	/** diff 双全文(§6):HEAD 全文 vs 工作区全文 */
	"git.fileDiff": {
		params: { workspaceId: string; path: string };
		response:
			| { ok: true; path: string; headContent: string; workContent: string; headExists: boolean }
			| { ok: false; error: string };
	};
	/** 同步(§6 独立操作):git fetch --all + 状态刷新 */
	"git.sync": {
		params: { workspaceId: string };
		response:
			| { ok: true; fetched: boolean; ahead: number; behind: number }
			| { ok: false; error: string };
	};
	/** 拉取请求:打开远端 compare 页(系统浏览器) */
	"git.openPullRequest": {
		params: { workspaceId: string };
		response: { ok: true; url: string } | { ok: false; error: string };
	};
	/** 搜索(§6 左侧搜索面板) */
	"fs.search": {
		params: { workspaceId: string; query: string; maxResults?: number };
		response:
			| { ok: true; results: Array<{ path: string; line: number; text: string }> }
			| { ok: false; error: string };
	};

	/** 无边框窗口控制(自定义标题栏) */
	"window.minimize": {
		params: {};
		response: { ok: true };
	};
	"window.toggleMaximize": {
		params: {};
		response: { ok: true; maximized: boolean } | { ok: false; error: string };
	};
	"window.close": {
		params: {};
		response: { ok: true };
	};

	"memory.status": {
		params: { workspaceId: string };
		response:
			| {
					ok: true;
					budget: { projectK: number; userK: number; sessionK: number; totalK: number; capK: number; nearLimit: boolean };
					entries: Array<{ scope: "project" | "user"; file: string; source: string; lines: string[]; lastHit?: string }>;
					agentsMd: string | null;
			  }
			| { ok: false; error: string };
	};
	/** 建议卡片:agent/会话沉淀提议(默认不静默写) */
	"memory.suggest": {
		params: { workspaceId: string; scope: "project" | "user"; file: string; lines: string[]; reason: string };
		response: { ok: true; suggestionId: string } | { ok: false; error: string };
	};
	/** 三动作:采纳(editedLines=改后采纳)/忽略 */
	"memory.decide": {
		params: { suggestionId: string; action: "adopt" | "ignore"; editedLines?: string[] };
		response:
			| { ok: true; wrote?: string }
			| { ok: false; error: string };
	};
	/** 整理:合并重复/淘汰过时,返回前后对照 */
	"memory.tidy": {
		params: { workspaceId: string };
		response:
			| { ok: true; before: number; after: number; changed: Array<{ scope: string; file: string; removed: string[] }> }
			| { ok: false; error: string };
	};
	/** 整理回退(.bak) */
	"memory.revertTidy": {
		params: { workspaceId: string };
		response: { ok: true; restored: number } | { ok: false; error: string };
	};
	/** 关键词召回(命中更新 lastHit,返回命中行) */
	"memory.recall": {
		params: { workspaceId: string; keywords: string[] };
		response:
			| { ok: true; hits: Array<{ scope: "project" | "user"; file: string; line: string }> }
			| { ok: false; error: string };
	};

	/** 把错误上下文(终端行/测试失败)送进对话(4F 错误一键问 agent) */
	"session.askWithContext": {
		params: {
			workspaceId: string;
			source: "terminal" | "test" | "preview";
			contextText: string;
			question?: string;
		};
		response: { ok: true } | { ok: false; error: string };
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
	| { type: "workspace.changed"; seq: number; projectId: string; activeWorkspaceId: string }
	| {
			type: "terminal.output";
			seq: number;
			terminalId: string;
			/** 增量输出(已按 xterm 写法序列化) */
			data: string;
	  }
	| { type: "terminal.exit"; seq: number; terminalId: string; code: number | null }
	| {
			type: "plan.updated";
			seq: number;
			planId: string;
			workspaceId: string;
			goal: string;
			steps: Array<{ text: string; state: "pending" | "doing" | "done"; commit?: string }>;
	  }
	| { type: "git.commits-updated"; seq: number; workspaceId: string }
	| {
			type: "devserver.status";
			seq: number;
			workspaceId: string;
			state: "stopped" | "starting" | "ready" | "crashed";
			url: string | null;
			probeMode: string;
	  }
	| {
			type: "test.progress";
			seq: number;
			workspaceId: string;
			phase: "selecting" | "running" | "done";
			selected: number;
			total: number;
			done: number;
			passed: number;
			failed: number;
	  }
	| {
			type: "checks.updated";
			seq: number;
			workspaceId: string;
			results: Array<{ id: string; title: string; passed: boolean; detail?: string }>;
	  }
	| {
			type: "review.updated";
			seq: number;
			projectId: string;
			pending: number;
	  }
	| {
			type: "preview.request";
			seq: number;
			/** 宿主请求 UI 打开内嵌预览(人侧运行档) */
			url: string;
	  }
	| {
			type: "memory.suggested";
			seq: number;
			suggestionId: string;
			scope: "project" | "user";
			file: string;
			lines: string[];
			reason: string;
	  }
	| {
			type: "memory.updated";
			seq: number;
			budget: { projectK: number; userK: number; sessionK: number; totalK: number; capK: number; nearLimit: boolean };
	  }
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
	"workspace.changed",
	"terminal.output",
	"terminal.exit",
	"plan.updated",
	"git.commits-updated",
	"devserver.status",
	"test.progress",
	"checks.updated",
	"review.updated",
	"preview.request",
	"memory.suggested",
	"memory.updated",
	"host.log",
]);

export function isHostEvent(value: unknown): value is HostEvent {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.type === "string" && EVENT_TYPES.has(v.type) && typeof v.seq === "number";
}

/** UI 侧事件分发器 */
export type HostEventHandler = (event: HostEvent) => void;
