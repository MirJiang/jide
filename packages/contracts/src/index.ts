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
export const PROTOCOL_VERSION = 3 as const;

/** 会话运行状态 */
export type SessionStatus =
	| "idle" // 已创建/空闲
	| "busy" // agent 主循环进行中
	| "aborted" // 被用户中断
	| "error" // 出错(见 detail)
	| "disposed"; // 已销毁,等待重建

/** 全局设置(~/.jide/settings.json,宿主持久化;默认值兜底) */
export interface JideSettings {
	/** 界面主题:system=跟随系统(默认)/ light=浅色 / dark=深色 */
	theme: "system" | "light" | "dark";
	/** 编辑器字号 px */
	editorFontSize: number;
	/** 终端字号 px */
	terminalFontSize: number;
	/** 终端默认 shell */
	terminalShell: "cmd" | "powershell" | "pwsh";
	/** dev server 默认参数(runTier「人侧运行」使用) */
	devserver: {
		port: number;
		probe: "auto" | "http" | "port" | "log";
		readyPattern: string;
		/** 空 = 宿主默认(bunx vite --port N) */
		command: string;
	};
	/**
	 * 常用模型列表(ThinkRail favoriteModels 语义):key = "<provider>/<modelId>",
	 * 按序展示于对话面板模型选择器;空 = 不限制(用 pi 自己的默认)。
	 */
	favoriteModels: string[];
	/** 新会话默认模型 key("<provider>/<modelId>");空 = pi 默认(不传 --model) */
	defaultModel: string;
	/** 编排模式(P2):会话获得委派工具(spawn_worker 等),可拆子任务给 Worker 池;默认开 */
	orchestrator: boolean;
	/** Router/精判专用模型 key;空 = 跟随默认模型(日志精判等隐性轻任务也用它) */
	routerModel: string;
	/** 开机自启(Windows 注册表 Run 键;dev 态指向 build2 launcher) */
	autostart: boolean;
	/** 关闭窗口驻留后台(DR-TS-06 opt-in):点 X 隐藏到托盘,daemon 与自动化继续跑;默认关(退出即全退) */
	keepRunningInTray: boolean;
}

/** pi 模型目录条目(get_available_models 投影;key = "<provider>/<modelId>") */
export interface PiModelInfo {
	key: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** 模型目录 key:"<provider>/<modelId>"(provider 不含 "/") */
export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/** 解析模型 key;非法(缺 provider 或 modelId)返回 null */
export function parseModelKey(key: string): { provider: string; modelId: string } | null {
	const i = key.indexOf("/");
	if (i <= 0 || i === key.length - 1) return null;
	return { provider: key.slice(0, i), modelId: key.slice(i + 1) };
}

/* ------------------------------------------------------------------ */
/* 自动化域(P1.5:定时/事件驱动的挂机任务)                          */
/* ------------------------------------------------------------------ */

/** 触发器:cron 表达式 / 每日 / 工作日 / 事件驱动 */
export type AutomationTrigger =
	| { kind: "cron"; /** 标准 5 字段:分 时 日 月 周(* , - /) */ expr: string }
	| { kind: "daily"; /** "HH:mm" */ time: string }
	| { kind: "weekdays"; /** 周一至周五,"HH:mm" */ time: string }
	| { kind: "event"; /** 事件类型:test 失败 / 检查项失败 */ type: "test-failed" | "checks-failed" };

/** 自动化任务:到点/事件 → 建会话跑 prompt →(可选)自动验证 → 评审队列 */
export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	trigger: AutomationTrigger;
	/** 发给 agent 的任务描述 */
	prompt: string;
	/** 模型 key("<provider>/<modelId>");空 = pi 默认 */
	modelKey: string;
	/** 目标:repo = 每次 run 新建隔离 worktree(自动提交+评审);workspace = 指定既有工作区 */
	target: { kind: "repo"; repoId: string } | { kind: "workspace"; workspaceId: string };
	/** 复用会话(同一会话连续对话);false = 每 run 新会话 */
	reuseSession: boolean;
	/** run 结束后自动 test_run + checks,结果进评审队列 */
	autoVerify: boolean;
	/** 分派方式:router = 提交常驻 Router 拆解分派 Worker;direct = 直接建会话执行。缺省 direct(存量兼容) */
	dispatch?: "router" | "direct";
	/** 单轮超时(分钟,默认 30) */
	timeoutMin: number;
	createdAt: number;
}

export interface AutomationRun {
	id: string;
	automationId: string;
	startedAt: number;
	durationMs?: number;
	status: "running" | "queued" | "ok" | "failed" | "timeout" | "aborted";
	/** 触发来源 */
	trigger: "manual" | "schedule" | "event";
	sessionId?: string;
	/** 实际分派路径:router = Router 委派;fallback = Router 未接管回退直执;direct = 直执 */
	dispatched?: "router" | "fallback" | "direct";
	/** 本轮实际目标工作区(repo 目标 = 新建隔离区) */
	workspaceId?: string;
	/** Router 分派产生的 Worker ids */
	workerIds?: string[];
	/** 摘要:模型回复尾 / 验证结果 */
	summary?: string;
	tests?: { selected: number; total: number; passed: number; failed: number };
	checks?: { total: number; passed: number };
	error?: string;
}

/** 解析自动化存储文件(损坏/缺字段回落) */
export interface AutomationStore {
	automations: Automation[];
	/** automationId → 最近 50 条运行记录 */
	runs: Record<string, AutomationRun[]>;
}

/** 编排 Worker 视图(P2;daemon 运行期实体,会话文件另存其历史) */
export interface WorkerRecordView {
	id: string;
	sessionId: string;
	workspaceId: string;
	objective: string;
	status: "queued" | "running" | "done" | "failed" | "timeout" | "aborted";
	startedAt: number;
	durationMs?: number;
	summary?: string;
	error?: string;
	/** 投机执行:隔离 worktree 静默修复 */
	speculative?: boolean;
	/** 投机验证结论 */
	verified?: "green" | "red" | "skipped";
	/** 发起方会话 id(完成回喂/任务卡归组) */
	routerSessionId?: string;
}

/* ---------------- 任务卡看板(P3.3:HiFox 语义本地化,数据源=编排数据) ---------------- */

/** 任务卡:聚合 Worker 池 / 竞赛 / 自动化运行的任务视图(daemon 运行期实体,tasks.json 落盘) */
export interface OrchestrationTask {
	id: string;
	/** 卡面标题(目标首行 / 自动化名 / 竞赛前缀) */
	title: string;
	/** 完整任务目标 */
	objective: string;
	/** 来源:聊天委派 / 自动化 / 竞赛 / 手动 */
	source: "chat" | "automation" | "race" | "manual";
	status: "running" | "verifying" | "awaiting-review" | "done" | "failed" | "cancelled";
	workspaceId?: string;
	projectId?: string;
	/** 归属 Worker ids(任务卡即 Worker 面板) */
	workerIds: string[];
	raceId?: string;
	automationId?: string;
	runId?: string;
	/** 发起方会话 id(聊天轮归组 / Router 分派链路) */
	routerSessionId?: string;
	/** 卡面摘要(Worker 摘要 / 竞赛最高分 / 运行结论) */
	summary?: string;
	createdAt: number;
	updatedAt: number;
}

/* ---------------- 竞赛域(P3:fan-out 一拖 N 对比选优) ---------------- */

export interface RaceEntry {
	/** 即 Worker id */
	workerId: string;
	workspaceId: string;
	branch: string;
	modelKey: string;
	status: WorkerRecordView["status"];
	/** 自动打分(0-100:测试通过与检查项通过各占一半;人工终审) */
	score?: number;
	verified?: "green" | "red" | "skipped";
	summary?: string;
	/** 收口提交(评审队列合并用) */
	sha?: string;
	changedFiles?: string[];
	error?: string;
}

export interface Race {
	id: string;
	objective: string;
	entries: RaceEntry[];
	status: "running" | "awaiting-review" | "resolved" | "cancelled";
	winnerEntryId?: string;
	createdAt: number;
	resolvedAt?: number;
	resolution?: "merged" | "discarded";
	/** 裁定说明(选优理由/丢弃原因) */
	note?: string;
}

/* ------------------------------------------------------------------ */
/* UI → 宿主:请求(全部枚举)                                        */
/* ------------------------------------------------------------------ */

/** 检查项断言(4E:http 探测 / browser 动作 / manual 人工) */
export interface CheckAssertion {
	type: "http" | "browser" | "manual";
	url?: string;
	expectStatus?: number;
	contains?: string;
	clickSelector?: string;
	expectContains?: string;
	note?: string;
}

export interface HostRequestShapes {
	/** 版本协商与宿主信息。连接后 UI 必须首先调用。 */
	"app.hello": {
		params: { protocolVersion: number };
		response:
			| { ok: true; protocolVersion: number; host: string }
			| { ok: false; error: string; expectedProtocolVersion: number };
	};
	/** 创建 agent 会话(一个工作区一个活动会话;M1 单会话) */
	"session.create": {
		params: { workspacePath: string };
		response:
			| { ok: true; sessionId: string; modelLabel: string }
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
			  }
			| { ok: false; error: string };
	};
	/**
	 * 回复 pi 扩展 UI 请求(agent.ui.request 事件;RPC Extension UI 子协议,v3)。
	 * dialog 类(select/confirm/input/editor)必须回;notify 类无需响应。
	 */
	"session.respondUI": {
		params: {
			sessionId: string;
			requestId: string;
			/** select/input/editor 的取值 */
			value?: string;
			/** confirm 的结果 */
			confirmed?: boolean;
			/** 任意 dialog 的取消 */
			cancelled?: boolean;
		};
		response: { ok: true } | { ok: false; error: string };
	};
	/** 切换活动会话模型(pi set_model,即时生效;返回模型显示名) */
	"session.setModel": {
		params: { sessionId: string; provider: string; modelId: string };
		response: { ok: true; modelLabel: string } | { ok: false; error: string };
	};
	/** 设置思考等级(pi set_thinking_level) */
	"session.setThinkingLevel": {
		params: { sessionId: string; level: string };
		response: { ok: true; level: string } | { ok: false; error: string };
	};
	/** 当前模型支持的思考等级 */
	"session.getThinkingLevels": {
		params: { sessionId: string };
		response: { ok: true; levels: string[] } | { ok: false; error: string };
	};
	/** 会话权限模式:auto = 自动执行;confirm = 每条 bash 命令先经用户确认(guard 扩展) */
	"session.setPermissionMode": {
		params: { sessionId: string; mode: "auto" | "confirm" };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 系统文件选择器(单文件;发送附件用) */
	"project.pickFile": {
		params: {};
		response: { ok: true; file: string | null } | { ok: false; error: string };
	};
	/** 读绝对路径文本文件(附件内联;上限 256KB,超出截断) */
	"fs.readAbsolute": {
		params: { path: string };
		response: { ok: true; content: string; size: number; truncated: boolean } | { ok: false; error: string };
	};
	/**
	 * pi 模型目录(get_available_models;宿主缓存,refresh 强制重拉 —— 拉起临时
	 * pi --no-session 进程,约 1-3s)。目录来自用户 ~/.pi 的模型配置。
	 */
	"models.list": {
		params: { refresh?: boolean };
		response: { ok: true; models: PiModelInfo[] } | { ok: false; error: string };
	};

	/* ---------------- 自动化域(P1.5) ---------------- */

	/** 列出自动化任务与运行历史 */
	"automations.list": {
		params: {};
		response:
			| { ok: true; automations: Automation[]; runs: Record<string, AutomationRun[]> }
			| { ok: false; error: string };
	};
	/** 新建/更新(automation.id 为空 = 新建);返回落库后的完整对象 */
	"automations.save": {
		params: { automation: Automation };
		response: { ok: true; automation: Automation } | { ok: false; error: string };
	};
	"automations.delete": {
		params: { id: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 编排 Worker 列表(P2;UI 呈现与 e2e 断言用) */
	"orchestrator.workers": {
		params: {};
		response: { ok: true; workers: WorkerRecordView[] } | { ok: false; error: string };
	};
	/** 立即手动运行(排队;运行记录经 automation.run 事件实时回推) */
	"automations.run": {
		params: { id: string };
		response: { ok: true; runId: string } | { ok: false; error: string };
	};
	"automations.runs": {
		params: { id: string };
		response: { ok: true; runs: AutomationRun[] } | { ok: false; error: string };
	};

	/* ---------------- 竞赛域(P3) ---------------- */

	"races.list": {
		params: {};
		response: { ok: true; races: Race[] } | { ok: false; error: string };
	};
	/**
	 * 开赛:同一任务书播 N 个隔离 worktree(可逐个指定模型),各自 Worker 执行,
	 * 收束后自动打分,等人工选优。variants 缺省 = 3 × pi 默认模型。
	 */
	"races.start": {
		params: { objective: string; workspaceId: string; variants?: Array<{ modelKey?: string }>; timeoutMin?: number };
		response: { ok: true; raceId: string } | { ok: false; error: string };
	};
	/** 选优:胜者分支合入主线(经评审队列合并逻辑),其余 worktree 清理 */
	"races.resolve": {
		params: { raceId: string; winnerWorkerId: string; note?: string };
		response: { ok: true; mergedSha?: string } | { ok: false; error: string };
	};
	/** 全部丢弃:清理所有 entry worktree */
	"races.discard": {
		params: { raceId: string; note?: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 取消运行中竞赛:中断 Worker + 清理 worktree */
	"races.cancel": {
		params: { raceId: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/* ---------------- 任务卡看板(P3.3:任务→Worker→验证→人收) ---------------- */

	"tasks.list": {
		params: {};
		response: { ok: true; tasks: OrchestrationTask[] } | { ok: false; error: string };
	};
	/** 清理终态卡片 */
	"tasks.dismiss": {
		params: { taskId: string };
		response: { ok: true } | { ok: false; error: string };
	};

	/* ---------------- 工作区域(W1-W4) ---------------- */

	/** 读取全局设置 */
	"settings.get": {
		params: {};
		response: { ok: true; settings: JideSettings } | { ok: false; error: string };
	};
	/** 部分更新全局设置(合并写入 settings.json),返回合并后的全量 */
	"settings.set": {
		params: { patch: Partial<JideSettings> };
		response: { ok: true; settings: JideSettings } | { ok: false; error: string };
	};
	/** 列出凭据库条目名(仅名称,永不返回值;§7.4 凭据零留存) */
	"credential.list": {
		params: {};
		response: { ok: true; names: string[] } | { ok: false; error: string };
	};
	/** 写入凭据(系统凭据库,user 如 provider 名) */
	"credential.set": {
		params: { name: string; secret: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 删除凭据 */
	"credential.delete": {
		params: { name: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** 系统目录选择对话框(打开项目用);用户取消 → folder:null */
	"project.pickFolder": {
		params: {};
		response: { ok: true; folder: string | null } | { ok: false; error: string };
	};
	/** 克隆远程 git 仓库到本地目录(打开远程项目第一步;完成后自行走 project.open) */
	"project.clone": {
		params: { url: string; dir: string };
		response: { ok: true; folder: string } | { ok: false; error: string };
	};
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
						/** P3.2 血缘:父工作区(stacked)/创建来源 */
						parentWorkspaceId?: string;
						source?: "user" | "stack" | "race" | "spec" | "auto";
					}>;
			  }
			| { ok: false; error: string };
	};
	/** 创建隔离工作区(worktree,W3)。仅已信任项目。 */
	"workspace.create": {
		params: { projectId: string; name: string; fromRef?: string; /** P3.2 stacked:父工作区(基点 = 父分支 HEAD) */ parentWorkspaceId?: string };
		response:
			| { ok: true; workspaceId: string; path: string; branch: string }
			| { ok: false; error: string };
	};
	/** 原子切换工作区(W4):会话/终端等上下文整套换入换出 */
	"workspace.switch": {
		params: { projectId: string; workspaceId: string };
		response: { ok: true; activeWorkspaceId: string } | { ok: false; error: string };
	};
	/** P3.2:移除隔离工作区(连带分支;Default 不可移除;有子工作区时拒绝) */
	"workspace.remove": {
		params: { projectId: string; workspaceId: string };
		response: { ok: true } | { ok: false; error: string };
	};
	/** P3.2:当前工作区成果提交(用户语义,Default 也可提交) */
	"git.commitAll": {
		params: { workspaceId: string; message: string };
		response: { ok: true; sha: string; message: string } | { ok: false; error: string };
	};
	/** P3.2:把工作区分支头(或指定 sha)提交进评审队列,人工批准后合入主线(stacked 按血缘 rebase) */
	"review.enqueueCommit": {
		params: { workspaceId: string; sha?: string; message?: string };
		response: { ok: true; itemId: string } | { ok: false; error: string };
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
			| { ok: true; terminalId: string; kind?: "pty" | "pipe" }
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
												assertion: CheckAssertion;
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
						/** P3.2:基分支(stacked 血缘;rebase 目标) */
						baseBranch?: string;
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
			| { ok: true; before: number; after: number; changed: Array<{ scope: string; file: string; removed: string[]; mergedInto?: string }> }
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
			source: "terminal" | "test" | "preview" | "review";
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
	/** 自动化任务列表变更(增删改/启停) */
	| { type: "automation.updated"; seq: number; automationId: string }
	/** 自动化运行记录变化(排队/开始/结束;UI 实时刷新运行历史) */
	| { type: "automation.run"; seq: number; run: AutomationRun }
	/** 任务卡变化(P3.3:建卡/推进/收口/清理) */
	| { type: "task.updated"; seq: number; taskId: string }
	/** 竞赛状态变化(P3:开赛/收口/裁定) */
	| { type: "race.updated"; seq: number; raceId: string }
	/**
	 * pi 扩展 UI 请求转发(RPC Extension UI 子协议,v3)。
	 * dialog 类(select/confirm/input/editor)须以 session.respondUI 回复(带 requestId);
	 * notify 为火后不管,仅呈现。
	 */
	| {
			type: "agent.ui.request";
			seq: number;
			sessionId: string;
			/** pi 侧请求 id(extension_ui_response 须原样带回) */
			requestId: string;
			method: "select" | "confirm" | "input" | "editor" | "notify";
			title?: string;
			/** select 的选项列表 */
			options?: string[];
			/** confirm 的说明文本 / notify 的内容 */
			message?: string;
			/** input 占位符 / editor 预填文本 */
			prefill?: string;
			notifyType?: "info" | "warning" | "error";
			/** pi 侧超时(ms);到期 pi 自动按默认值解决,客户端无须计时 */
			timeout?: number;
	  }
	| { type: "host.log"; seq: number; level: "info" | "warn" | "error"; message: string };

export type HostEventType = HostEvent["type"];

/** 逐分支分发 Omit(直接 Omit<联合,K> 会坍缩为公共字段,误伤变体特有字段) */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** 事件输入(未分配 seq):emit/append 侧用;逐分支分发,保留变体特有字段 */
export type HostEventInput = DistributiveOmit<HostEvent, "seq">;

/** 事件日志(journal):宿主持有,UI 崩溃重连后按 lastSeq 增量补发 = 可回放 */
export interface EventJournal {
	/** 目前已分配的最大 seq */
	lastSeq(): number;
	/** 取 (afterSeq, ...] 区间的事件 */
	since(afterSeq: number): HostEvent[];
	/** 追加事件并分配 seq */
	append(event: HostEventInput): HostEvent;
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
	"agent.ui.request",
	"automation.updated",
	"automation.run",
	"race.updated",
	"task.updated",
	"host.log",
]);

/** 事件类型守卫(不含 seq 校验):服务侧发出原始事件(无 seq)时的最低限度校验 */
export function isHostEventType(type: unknown): type is HostEventType {
	return typeof type === "string" && EVENT_TYPES.has(type);
}

/** 线上事件守卫(type + seq 齐全;接收侧用) */
export function isHostEvent(value: unknown): value is HostEvent {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return isHostEventType(v.type) && typeof v.seq === "number";
}

/** UI 侧事件分发器 */
export type HostEventHandler = (event: HostEvent) => void;
