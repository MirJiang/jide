/**
 * UI 状态(zustand)— M2 IDE 基面
 * 状态三分(business-design §7.3):本文件全部为可弃 UI 态;
 * 会话态在 pi(宿主),项目态在文件/git(唯一事实源),UI 恢复 = 重放事件 + 拉快照。
 */

import { create } from "zustand";
import {
	PROTOCOL_VERSION,
	parseModelKey,
	type Automation,
	type AutomationRun,
	type HostEvent,
	type Race,
	type SessionStatus,
	type JideSettings,
	type PiModelInfo,
} from "@jide/contracts";
import type { JideClient } from "./rpc";

export interface ChatMessage {
	id: number;
	role: "user" | "assistant";
	text: string;
	tool?: string;
	toolError?: boolean;
}

export interface EditorTab {
	kind: "chat" | "file" | "diff" | "preview";
	/** file: 工作区相对路径 */
	path?: string;
	title: string;
	dirty?: boolean;
	/** 后台变更绿点 */
	spotted?: boolean;
	content?: string;
	savedContent?: string;
	size?: number;
}

export interface PlanView {
	planId: string;
	goal: string;
	steps: Array<{ text: string; state: "pending" | "doing" | "done"; commit?: string }>;
}

export interface WorkspaceView {
	id: string;
	kind: "default" | "worktree";
	branch: string;
	path: string;
	/** P3.2 血缘:父工作区(stacked)/创建来源 */
	parentWorkspaceId?: string;
	source?: "user" | "stack" | "race" | "spec" | "auto";
}

export interface ProjectView {
	id: string;
	root: string;
	name: string;
	trusted: boolean;
	branch: string | null;
}

interface IDEStore {
	client: JideClient | null;
	connected: boolean;
	hostName: string;

	project: ProjectView | null;
	workspaces: WorkspaceView[];
	activeWorkspaceId: string | null;
	/** 项目对话框:null=关闭;"trust"=信任确认(打开项目走标题栏下拉,不再弹窗) */
	projectDialog: "trust" | null;
	/** 标题栏「项目」下拉菜单开关 */
	projectMenuOpen: boolean;

	sidebar: "files" | "search" | "git" | "memory";
	bottomVisible: boolean;
	bottomTab: "terminal" | "tests" | "checks";

	/** 全局设置(宿主持久化);启动时拉取,保存走 saveSettings */
	settings: JideSettings | null;
	settingsOpen: boolean;

	tabs: EditorTab[];
	activeTab: string; // "chat" 或 file path

	chat: {
		sessionId: string | null;
		status: SessionStatus;
		messages: ChatMessage[];
		streaming: string;
		modelLabel: string;
	};

	terminals: Array<{ id: string; workspaceId: string }>;
	/** 终端输出环形缓冲(每终端尾 50 行,供「问 agent」取上下文) */
	terminalBuffers: Record<string, string[]>;
	activeTerminalId: string | null;

	plan: PlanView | null;

	git: {
		branch: string;
		changes: Array<{ path: string; kind: "M" | "A" | "D" | "?" }>;
		ahead: number;
		behind: number;
		commits: Array<{
			shortSha: string;
			message: string;
			author: string;
			date: string;
			isAgent: boolean;
		}>;
	};

	logs: string[];
	lastSeq: number;

	reviewPending: number;
	memoryBudget: { projectK: number; userK: number; sessionK: number; totalK: number; capK: number; nearLimit: boolean };
	memorySuggestions: Array<{ suggestionId: string; file: string; lines: string[]; reason: string }>;
	devserver: { state: string; url: string | null; probeMode: string };

	/** pi 扩展 UI 请求待办(agent.ui.request;dialog 类须用户回答,notify 类可关闭) */
	uiRequests: Array<{
		sessionId: string;
		requestId: string;
		method: "select" | "confirm" | "input" | "editor" | "notify";
		title?: string;
		options?: string[];
		message?: string;
		prefill?: string;
		notifyType?: "info" | "warning" | "error";
	}>;
	/** 回复 pi 扩展 UI 请求并移除卡片 */
	respondUI(requestId: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void>;

	/** pi 模型目录(get_available_models 缓存投影;空 = 尚未拉取) */
	modelCatalog: PiModelInfo[];
	modelCatalogLoading: boolean;
	/** 拉取模型目录(宿主缓存 5min;force 重拉临时 pi 进程) */
	refreshModels(force?: boolean): Promise<void>;
	/** 切换当前会话模型(pi set_model 即时生效) */
	setSessionModel(provider: string, modelId: string): Promise<void>;

	/** 自动化任务(P1.5):列表 + 运行历史(automation.run 事件实时更新) */
	automations: Automation[];
	automationRuns: Record<string, AutomationRun[]>;
	refreshAutomations(): Promise<void>;
	saveAutomation(a: Automation): Promise<string | null>;
	deleteAutomation(id: string): Promise<void>;
	runAutomation(id: string): Promise<void>;

	/** 竞赛(P3):fan-out 一拖 N 对比选优 */
	races: Race[];
	refreshRaces(): Promise<void>;
	startRace(objective: string, variants: Array<{ modelKey?: string }>): Promise<string | null>;
	resolveRace(raceId: string, winnerWorkerId: string): Promise<void>;
	discardRace(raceId: string): Promise<void>;
	cancelRace(raceId: string): Promise<void>;

	/** 外部投递待办(终端/测试/评审 →「问 agent」):ChatPanel 消费后清空,填入输入框待用户确认发送 */
	chatPrefill: string | null;
	askAgent(source: string, contextText: string, question: string): Promise<void>;
	runTier(tier: "agent" | "human" | "cdp"): Promise<void>;
	refreshReview(): Promise<void>;

	boot(client: JideClient): Promise<void>;
	openProject(path: string): Promise<boolean>;
	trustProject(): Promise<void>;
	showProjectDialog(): void;
	setProjectMenuOpen(v: boolean): void;
	closeProjectDialog(): void;
	setSettingsOpen(v: boolean): void;
	saveSettings(patch: Partial<JideSettings>): Promise<void>;
	switchWorkspace(id: string): Promise<void>;
	createWorktree(name: string, opts?: { stacked?: boolean }): Promise<void>;
	/** P3.2:提交当前工作区全部变更并送入评审队列(人工批准后合入主线);返回错误文本或 null */
	commitAndReview(message: string): Promise<string | null>;

	setSidebar(v: IDEStore["sidebar"]): void;
	toggleBottom(v?: boolean): void;
	setBottomTab(t: IDEStore["bottomTab"]): void;

	openFile(path: string): Promise<void>;
	openDiff(path: string): Promise<void>;
	diffTabKey(path: string): string;
	openPreview(url: string): void;
	setActiveTab(key: string): void;
	closeTab(key: string): void;
	saveActiveTab(): Promise<void>;
	markDirty(path: string, content: string): void;

	createTerminal(): Promise<void>;
	terminalWrite(id: string, data: string): void;
	terminalDispose(id: string): void;

	send(text: string): Promise<void>;
	abort(): Promise<void>;
	rebuild(): Promise<void>;
	createPlan(goal: string, steps: string[]): Promise<void>;
	planStepDone(index: number): Promise<void>;
	refreshGit(): Promise<void>;

	handleEvent(event: HostEvent): void;

	// ---- M3 ----
}

let nextMsgId = 1;
const tabKey = (t: { kind: string; path?: string }) => (t.kind === "chat" ? "chat" : t.kind === "diff" ? "diff:" + t.path : t.path!);

export const useIDE = create<IDEStore>((set, get) => ({
	client: null,
	connected: false,
	hostName: "",

	project: null,
	workspaces: [],
	activeWorkspaceId: null,
	projectDialog: null,
	projectMenuOpen: false,

	sidebar: "files",
	bottomVisible: true,
	bottomTab: "terminal",

	settings: null,
	settingsOpen: false,

	tabs: [{ kind: "chat", title: "Agent 对话" }],
	activeTab: "chat",

	chat: {
		sessionId: null,
		status: "idle",
		messages: [],
		streaming: "",
		modelLabel: "",
	},

	terminals: [],
	activeTerminalId: null,
	terminalBuffers: {},

	plan: null,

	git: { branch: "", changes: [], ahead: 0, behind: 0, commits: [] },

	logs: [],
	lastSeq: 0,

	reviewPending: 0,
	memoryBudget: { projectK: 0, userK: 0, sessionK: 0, totalK: 0, capK: 2, nearLimit: false },
	memorySuggestions: [],
	devserver: { state: "stopped", url: null, probeMode: "auto" },
	uiRequests: [],
	modelCatalog: [],
	modelCatalogLoading: false,
	chatPrefill: null,
	automations: [],
	automationRuns: {},
	races: [],

	async boot(client) {
		set({ client });
		const hello = await client.request("app.hello", { protocolVersion: PROTOCOL_VERSION });
		if (!hello.ok) {
			set((s) => ({ logs: [...s.logs, `协议协商失败:${hello.error}`] }));
			return;
		}
		set({ connected: true, hostName: hello.host });
		// 全局设置(字号/shell/devserver 默认参数)
		const st = await client.request("settings.get", {});
		if (st.ok) set({ settings: st.settings });
	},

	async openProject(path) {
		const { client, workspaces } = get();
		if (!client) return false;
		const r = await client.request("project.open", { path });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `打开项目失败:${r.error}`] }));
			return false;
		}
		set({
			project: { id: r.projectId, root: r.root, name: r.name, trusted: r.trusted, branch: r.branch },
			// 首次打开 → 弹信任确认;曾信任过的项目 → 直接进入
			projectDialog: r.trusted ? null : "trust",
		});
		const list = await client.request("workspace.list", { projectId: r.projectId });
		if (list.ok) {
			const wss: WorkspaceView[] = list.workspaces.map((w) => ({
				id: w.id,
				kind: w.kind,
				branch: w.branch,
				path: w.path,
				parentWorkspaceId: w.parentWorkspaceId,
				source: w.source,
			}));
			set({ workspaces: wss, activeWorkspaceId: list.activeWorkspaceId });
			// 初始会话挂到当前工作区
			const created = await client.request("session.create", {
				workspacePath: wss.find((w) => w.id === list.activeWorkspaceId)?.path ?? "",
			});
			if (created.ok) {
				set((s) => ({
					chat: { ...s.chat, sessionId: created.sessionId, modelLabel: created.modelLabel },
				}));
			}
			// 恢复当前工作区的计划(上下文随工作区)
			if (list.activeWorkspaceId) {
				const planR = await client.request("plan.get", { workspaceId: list.activeWorkspaceId });
				set({
					plan: planR.ok && planR.plan
						? { planId: planR.plan.planId, goal: planR.plan.goal, steps: planR.plan.steps }
						: null,
				});
			}
		}
		void get().refreshGit();
		return true;
	},

	async trustProject() {
		const { client, project } = get();
		if (!client || !project) return;
		const r = await client.request("project.trust", { projectId: project.id });
		if (r.ok) set((s) => ({ project: s.project ? { ...s.project, trusted: true } : s.project, projectDialog: null }));
	},

	showProjectDialog() {
		// 仅用于信任确认(未信任项目);打开/切换项目走标题栏下拉
		set({ projectDialog: "trust" });
	},

	setProjectMenuOpen(v: boolean) {
		set({ projectMenuOpen: v });
	},

	closeProjectDialog() {
		set({ projectDialog: null });
	},

	setSettingsOpen(v: boolean) {
		set({ settingsOpen: v });
	},

	/** 部分更新设置(宿主合并持久化) */
	async saveSettings(patch) {
		const { client } = get();
		if (!client) return;
		const r = await client.request("settings.set", { patch });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `设置保存失败:${r.error}`] }));
			return;
		}
		set({ settings: r.settings });
	},

	async switchWorkspace(id) {
		const { client, project } = get();
		if (!client || !project) return;
		const r = await client.request("workspace.switch", { projectId: project.id, workspaceId: id });
		if (!r.ok) return;
		set({ activeWorkspaceId: id });
		// 刷新工作区列表(新建的 worktree 需枚举进来)
		const list = await client.request("workspace.list", { projectId: project.id });
		if (list.ok) {
			set({
				workspaces: list.workspaces.map((w) => ({ id: w.id, kind: w.kind, branch: w.branch, path: w.path, parentWorkspaceId: w.parentWorkspaceId, source: w.source })),
			});
		}
		// W4 原子换入:重建会话 + 终端清空 + 计划随工作区恢复
		const ws = get().workspaces.find((w) => w.id === id);
		const created = await client.request("session.create", {
			workspacePath: ws?.path ?? "",
		});
		if (created.ok) {
			set((s) => ({
				chat: { sessionId: created.sessionId, status: "idle", messages: [], streaming: "", modelLabel: created.modelLabel },
			}));
		}
		const planR = await client.request("plan.get", { workspaceId: id });
		set({
			plan: planR.ok && planR.plan
				? { planId: planR.plan.planId, goal: planR.plan.goal, steps: planR.plan.steps }
				: null,
		});
		for (const t of get().terminals) client.request("terminal.dispose", { terminalId: t.id });
		set({ terminals: [], activeTerminalId: null, tabs: [{ kind: "chat", title: "Agent 对话" }], activeTab: "chat" });
		void get().refreshGit();
	},

	async createWorktree(name, opts?: { stacked?: boolean }) {
		const { client, project, activeWorkspaceId } = get();
		if (!client || !project) return;
		const r = await client.request("workspace.create", {
			projectId: project.id,
			name,
			...(opts?.stacked && activeWorkspaceId ? { parentWorkspaceId: activeWorkspaceId } : {}),
		});
		if (r.ok) {
			await get().switchWorkspace(r.workspaceId);
		} else {
			set((s) => ({ logs: [...s.logs, `创建工作区失败:${r.error}`] }));
		}
	},

	async commitAndReview(message) {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return "未连接宿主或未选工作区";
		const c = await client.request("git.commitAll", { workspaceId: activeWorkspaceId, message });
		if (!c.ok) return c.error;
		const e = await client.request("review.enqueueCommit", { workspaceId: activeWorkspaceId });
		if (!e.ok) return e.error;
		void get().refreshGit();
		return null;
	},

	setSidebar(v) {
		set({ sidebar: v });
	},
	toggleBottom(v) {
		set((s) => ({ bottomVisible: v ?? !s.bottomVisible }));
	},
	setBottomTab(t) {
		set({ bottomTab: t, bottomVisible: true });
	},

	async openFile(path) {
		const { client, activeWorkspaceId, tabs } = get();
		if (!client || !activeWorkspaceId) return;
		const existing = tabs.find((t) => t.kind === "file" && t.path === path);
		if (existing) {
			set((s) => ({
				activeTab: path,
				tabs: s.tabs.map((t) => (tabKey(t) === path ? { ...t, spotted: false } : t)),
			}));
			return;
		}
		const r = await client.request("fs.read", { workspaceId: activeWorkspaceId, relPath: path });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `读取失败:${path}:${r.error}`] }));
			return;
		}
		const name = path.split(/[\\/]/).pop() ?? path;
		set((s) => ({
			tabs: [...s.tabs, { kind: "file", path, title: name, content: r.content, savedContent: r.content, size: r.size }],
			activeTab: path,
		}));
	},

	setActiveTab(key) {
		set((s) => ({
			activeTab: key,
			tabs: s.tabs.map((t) => (tabKey(t) === key ? { ...t, spotted: false } : t)),
		}));
	},

	closeTab(key) {
		if (key === "chat") return;
		set((s) => {
			const idx = s.tabs.findIndex((t) => tabKey(t) === key);
			const tabs = s.tabs.filter((t) => tabKey(t) !== key);
			const activeTab = s.activeTab === key ? (tabs[Math.max(0, idx - 1)] ? tabKey(tabs[Math.max(0, idx - 1)]) : "chat") : s.activeTab;
			return { tabs, activeTab };
		});
	},

	async saveActiveTab() {
		const { client, activeWorkspaceId, activeTab, tabs } = get();
		const tab = tabs.find((t) => tabKey(t) === activeTab);
		if (!client || !activeWorkspaceId || !tab || tab.kind !== "file" || !tab.dirty) return;
		const r = await client.request("fs.write", {
			workspaceId: activeWorkspaceId,
			relPath: tab.path!,
			content: tab.content ?? "",
		});
		if (r.ok) {
			set((s) => ({
				tabs: s.tabs.map((t) =>
					tabKey(t) === activeTab ? { ...t, dirty: false, savedContent: t.content } : t,
				),
			}));
			void get().refreshGit();
		} else {
			set((s) => ({ logs: [...s.logs, `保存失败:${r.error}`] }));
		}
	},

	markDirty(path, content) {
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.kind === "file" && t.path === path
					? { ...t, content, dirty: content !== t.savedContent }
					: t,
			),
		}));
	},

	async createTerminal() {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return;
		const ws = get().workspaces.find((w) => w.id === activeWorkspaceId);
		const r = await client.request("terminal.create", { workspaceId: activeWorkspaceId, cwd: ws?.path });
		if (r.ok) {
			set((s) => ({
				terminals: [...s.terminals, { id: r.terminalId, workspaceId: activeWorkspaceId! }],
				activeTerminalId: r.terminalId,
				bottomVisible: true,
				bottomTab: "terminal",
			}));
		}
	},

	terminalWrite(id, data) {
		get().client?.request("terminal.write", { terminalId: id, data });
	},

	terminalDispose(id) {
		get().client?.request("terminal.dispose", { terminalId: id });
		set((s) => {
			const terminals = s.terminals.filter((t) => t.id !== id);
			return {
				terminals,
				activeTerminalId: s.activeTerminalId === id ? (terminals[0]?.id ?? null) : s.activeTerminalId,
			};
		});
	},

	async send(text) {
		const { client, chat } = get();
		if (!client || !chat.sessionId || !text.trim()) return;
		set((s) => ({
			chat: {
				...s.chat,
				messages: [...s.chat.messages, { id: nextMsgId++, role: "user", text: text.trim() }],
			},
		}));
		const r = await client.request("session.prompt", { sessionId: chat.sessionId, text });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `发送失败:${r.error}`] }));
	},

	async abort() {
		const { client, chat } = get();
		if (!client || !chat.sessionId) return;
		const r = await client.request("session.abort", { sessionId: chat.sessionId });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `停止失败:${r.error}`] }));
	},

	async respondUI(requestId, resp) {
		const { client, chat } = get();
		const pending = get().uiRequests.find((u) => u.requestId === requestId);
		if (!client || !pending) return;
		// 乐观移除(重复点击不再二次回写)
		set((s) => ({ uiRequests: s.uiRequests.filter((u) => u.requestId !== requestId) }));
		const sessionId = pending.sessionId || chat.sessionId;
		if (!sessionId) return;
		const r = await client.request("session.respondUI", { sessionId, requestId, ...resp });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `扩展请求回复失败:${r.error}`] }));
	},

	async refreshModels(force) {
		const { client } = get();
		if (!client || get().modelCatalogLoading) return;
		set({ modelCatalogLoading: true });
		const r = await client.request("models.list", { refresh: force === true });
		if (r.ok) set({ modelCatalog: r.models, modelCatalogLoading: false });
		else {
			set({ modelCatalogLoading: false });
			set((s) => ({ logs: [...s.logs, `模型目录获取失败:${r.error}`] }));
		}
	},

	async setSessionModel(provider, modelId) {
		const { client, chat } = get();
		if (!client || !chat.sessionId) return;
		const r = await client.request("session.setModel", { sessionId: chat.sessionId, provider, modelId });
		if (r.ok) {
			set((s) => ({ chat: { ...s.chat, modelLabel: r.modelLabel } }));
		} else {
			set((s) => ({ logs: [...s.logs, `模型切换失败:${r.error}`] }));
		}
	},

	async refreshAutomations() {
		const { client } = get();
		if (!client) return;
		const r = await client.request("automations.list", {});
		if (r.ok) set({ automations: r.automations, automationRuns: r.runs });
	},

	async saveAutomation(a) {
		const { client } = get();
		if (!client) return "未连接宿主";
		const r = await client.request("automations.save", { automation: a });
		if (r.ok) {
			await get().refreshAutomations();
			return null;
		}
		return r.error;
	},

	async deleteAutomation(id) {
		const { client } = get();
		if (!client) return;
		await client.request("automations.delete", { id });
		await get().refreshAutomations();
	},

	async runAutomation(id) {
		const { client } = get();
		if (!client) return;
		const r = await client.request("automations.run", { id });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `自动化启动失败:${r.error}`] }));
	},

	async refreshRaces() {
		const { client } = get();
		if (!client) return;
		const r = await client.request("races.list", {});
		if (r.ok) set({ races: r.races });
	},

	async startRace(objective, variants) {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return "未连接宿主或未选工作区";
		const r = await client.request("races.start", { objective, workspaceId: activeWorkspaceId, variants });
		if (r.ok) {
			await get().refreshRaces();
			return null;
		}
		return r.error;
	},

	async resolveRace(raceId, winnerWorkerId) {
		const { client } = get();
		if (!client) return;
		const r = await client.request("races.resolve", { raceId, winnerWorkerId });
		if (r.ok) {
			await get().refreshRaces();
			void get().refreshGit();
		} else {
			set((s) => ({ logs: [...s.logs, `选优失败:${r.error}`] }));
		}
	},

	async discardRace(raceId) {
		const { client } = get();
		if (!client) return;
		await client.request("races.discard", { raceId });
		await get().refreshRaces();
	},

	async cancelRace(raceId) {
		const { client } = get();
		if (!client) return;
		await client.request("races.cancel", { raceId });
		await get().refreshRaces();
	},

	async rebuild() {
		const { client, chat } = get();
		if (!client || !chat.sessionId) return;
		const r = await client.request("session.rebuild", { sessionId: chat.sessionId });
		if (!r.ok) return;
		// 旧会话的待答扩展 UI 请求随引擎销毁作废(pi 侧 timeout 兜底)
		set((s) => ({ uiRequests: s.uiRequests.filter((u) => !chat.sessionId || u.sessionId !== chat.sessionId) }));
		const snap = await client.request("session.get", { sessionId: r.sessionId });
		if (snap.ok) {
			set({
				chat: {
					sessionId: snap.sessionId,
					status: snap.status,
					messages: snap.messages.map((m) => ({ id: nextMsgId++, ...m })),
					streaming: "",
					modelLabel: snap.modelLabel,
				},
			});
		}
	},

	async createPlan(goal, steps) {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return;
		const r = await client.request("plan.create", { workspaceId: activeWorkspaceId, goal, steps });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `计划创建失败:${r.error}`] }));
	},

	async planStepDone(index) {
		const { client, plan } = get();
		if (!client || !plan) return;
		const r = await client.request("plan.stepDone", { planId: plan.planId, stepIndex: index });
		if (!r.ok) set((s) => ({ logs: [...s.logs, `步骤推进失败:${r.error}`] }));
	},

	async refreshGit() {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return;
		const st = await client.request("git.status", { workspaceId: activeWorkspaceId });
		if (st.ok) {
			set((s) => ({
				git: { ...s.git, branch: st.branch, changes: st.changes, ahead: st.ahead, behind: st.behind },
				// 页签绿点(§6):后台变更的文件页签打点,非活动页签亮绿
				tabs: s.tabs.map((t) => {
					if (t.kind !== "file" || !t.path) return t;
					const changed = st.changes.some((c) => c.path === t.path);
					return changed && s.activeTab !== t.path ? { ...t, spotted: true } : t;
				}),
			}));
		}
		const log = await client.request("git.log", { workspaceId: activeWorkspaceId, limit: 30 });
		if (log.ok) {
			set((s) => ({
				git: {
					...s.git,
					commits: log.commits.map((c) => ({
						shortSha: c.shortSha,
						message: c.message,
						author: c.author,
						date: c.date,
						isAgent: c.isAgent,
					})),
				},
			}));
		}
	},

	async askAgent(source, contextText, question) {
		// 4F 错误一键问 agent(Orca prefill 语义):切到对话页签,把上下文预填进输入框,
		// 用户按 Enter 才真正发送(人在环:不意外起轮、不烧配额;可编辑后发送)。
		// 旧行为(伪造一条未发送的用户消息)已废弃 —— 那只是 UI 假象,agent 根本没收到。
		const { client, activeWorkspaceId } = get();
		const label = { test: "测试失败", terminal: "终端输出", review: "评审项" }[source] ?? source;
		set({ activeTab: "chat" });
		if (client && activeWorkspaceId) {
			await client.request("session.askWithContext", { workspaceId: activeWorkspaceId, source, contextText, question });
		}
		set((st) => ({
			logs: [...st.logs, `[ctx·${label}] ${contextText.slice(0, 80)}`],
			chatPrefill: `【来自${label}】\n${contextText}\n\n${question}`,
		}));
	},

	async runTier(tier) {
		const { client, activeWorkspaceId } = get();
		if (!client || !activeWorkspaceId) return;
		if (tier === "agent") {
			// ① Agent 自测:后台静默,结果徽标+摘要
			const r = await client.request("run.agentSelfTest", { workspaceId: activeWorkspaceId });
			if (r.ok) {
				set((st) => ({ logs: [...st.logs, "Agent 自测:" + r.summary] }));
			}
		} else if (tier === "human") {
			// ② 人侧运行 + 预览:起 dev server(共享),宿主开预览窗口
			// 设置中的 dev server 默认参数一并下发(command 留空 = 宿主默认)
			const dsCfg = get().settings?.devserver;
			const ds = await client.request("devserver.ensure", {
				workspaceId: activeWorkspaceId,
				port: dsCfg?.port,
				probe: dsCfg?.probe,
				readyPattern: dsCfg?.readyPattern || undefined,
				command: dsCfg?.command || undefined,
			});
			if (ds.ok) {
				set({ devserver: { state: "ready", url: ds.url, probeMode: ds.probeMode } });
				await client.request("preview.open", { url: ds.url });
			}
		} else {
			// ③ CDP 后门:提示端点(断点调试器为非目标)
			set((st) => ({ logs: [...st.logs, "③ CDP 后门:devtools 端点见 dev server 输出(/json/version)"] }));
		}
	},

	async refreshReview() {
		const { client, project } = get();
		if (!client || !project) return;
		const r = await client.request("review.list", { projectId: project.id });
		if (r.ok) {
			set({ reviewPending: r.items.filter((x: any) => x.state === "pending").length });
		}
	},

	handleEvent(event) {
		set({ lastSeq: event.seq });
		switch (event.type) {
			case "session.created":
				set((s) => ({
					chat: { ...s.chat, sessionId: event.sessionId, modelLabel: event.modelLabel },
				}));
				break;
			case "session.status":
				set((s) => ({ chat: { ...s.chat, status: event.status } }));
				break;
			case "agent.text-delta":
				set((s) => ({ chat: { ...s.chat, streaming: s.chat.streaming + event.delta } }));
				break;
			case "agent.message":
				if (event.role === "assistant") {
					set((s) => ({
						chat: {
							...s.chat,
							messages: [
								...s.chat.messages,
								{ id: nextMsgId++, role: "assistant", text: event.text },
							],
							streaming: "",
						},
					}));
				}
				break;
			case "agent.tool":
				set((s) => ({
					chat: {
						...s.chat,
						messages: [
							...s.chat.messages,
							{
								id: nextMsgId++,
								role: "assistant",
								text:
									event.phase === "start"
										? `调用工具 ${event.toolName} …`
										: `工具 ${event.toolName} 完成${event.isError ? "(出错)" : ""}`,
								tool: event.toolName,
								toolError: event.isError,
							},
						],
					},
				}));
				break;
			case "terminal.output":
				set((st) => {
					const buf = [...(st.terminalBuffers[event.terminalId] ?? []), event.data];
					if (buf.length > 50) buf.splice(0, buf.length - 50);
					return { terminalBuffers: { ...st.terminalBuffers, [event.terminalId]: buf } };
				});
				window.dispatchEvent(new CustomEvent("jide-event", { detail: event }));
				break;
			case "terminal.exit":
				window.dispatchEvent(new CustomEvent("jide-event", { detail: event }));
				break;
			case "workspace.changed":
				set({ activeWorkspaceId: event.activeWorkspaceId });
				break;
			case "plan.updated":
				set({
					plan: {
						planId: event.planId,
						goal: event.goal,
						steps: event.steps.map((st) => ({ text: st.text, state: st.state, commit: st.commit })),
					},
				});
				break;
			case "git.commits-updated":
				void get().refreshGit();
				break;
			case "devserver.status":
				set({ devserver: { state: event.state, url: event.url, probeMode: event.probeMode } });
				break;
			case "memory.suggested":
				set((st) => ({
					memorySuggestions: [...st.memorySuggestions, { suggestionId: event.suggestionId, file: event.file, lines: event.lines, reason: event.reason }],
				}));
				break;
			case "memory.updated":
				set({ memoryBudget: event.budget });
				break;
			case "automation.updated":
				void get().refreshAutomations();
				break;
			case "automation.run": {
				// 运行记录实时更新(queued/running/终态),不整表重拉
				const run = event.run;
				set((st) => {
					const list = [...(st.automationRuns[run.automationId] ?? [])];
					const i = list.findIndex((r) => r.id === run.id);
					if (i >= 0) list[i] = run;
					else list.unshift(run);
					return { automationRuns: { ...st.automationRuns, [run.automationId]: list.slice(0, 50) } };
				});
				break;
			}
			case "race.updated":
				void get().refreshRaces();
				break;
			case "agent.ui.request":
				// pi 扩展 UI 请求:dialog 入待办卡片;notify 直落日志流(火后不管)
				if (event.method === "notify") {
					const tag = event.notifyType === "error" ? "错误" : event.notifyType === "warning" ? "警告" : "提示";
					set((s) => ({ logs: [...s.logs, `[agent·${tag}] ${event.title ?? ""}${event.message ?? ""}`.trim()] }));
					break;
				}
				set((s) => ({
					uiRequests: [
						...s.uiRequests.filter((u) => u.requestId !== event.requestId),
						{
							sessionId: event.sessionId,
							requestId: event.requestId,
							method: event.method,
							title: event.title,
							options: event.options,
							message: event.message,
							prefill: event.prefill,
							notifyType: event.notifyType,
						},
					],
				}));
				break;
			case "review.updated":
				void get().refreshReview();
				break;
			case "test.progress":
				if (event.phase === "done") {
					set((st) => ({ logs: [...st.logs, `测试完成:${event.passed} 通过 · ${event.failed} 失败(选测 ${event.selected}/${event.total})`] }));
				}
				break;
			case "host.log":
				set((s) => ({ logs: [...s.logs, `[${event.level}] ${event.message}`] }));
				break;
			default:
				break;
		}
	},
}));

export { tabKey };
