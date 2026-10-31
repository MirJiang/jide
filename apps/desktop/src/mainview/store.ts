/**
 * UI 状态(zustand)— M2 IDE 基面
 * 状态三分(business-design §7.3):本文件全部为可弃 UI 态;
 * 会话态在 pi(宿主),项目态在文件/git(唯一事实源),UI 恢复 = 重放事件 + 拉快照。
 */

import { create } from "zustand";
import type { HostEvent, SessionStatus } from "@jide/contracts";
import type { JideClient } from "./rpc";

export interface ChatMessage {
	id: number;
	role: "user" | "assistant";
	text: string;
	tool?: string;
	toolError?: boolean;
}

export interface EditorTab {
	kind: "chat" | "file" | "diff";
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
	demo: boolean;

	project: ProjectView | null;
	workspaces: WorkspaceView[];
	activeWorkspaceId: string | null;

	sidebar: "files" | "search" | "git" | "memory";
	bottomVisible: boolean;
	bottomTab: "terminal" | "tests" | "checks";

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

	askAgent(source: string, contextText: string, question: string): Promise<void>;
	runTier(tier: "agent" | "human" | "cdp"): Promise<void>;
	refreshReview(): Promise<void>;

	boot(client: JideClient): Promise<void>;
	openProject(path: string): Promise<void>;
	trustProject(): Promise<void>;
	switchWorkspace(id: string): Promise<void>;
	createWorktree(name: string): Promise<void>;

	setSidebar(v: IDEStore["sidebar"]): void;
	toggleBottom(v?: boolean): void;
	setBottomTab(t: IDEStore["bottomTab"]): void;

	openFile(path: string): Promise<void>;
	openDiff(path: string): Promise<void>;
	diffTabKey(path: string): string;
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
	demo: false,

	project: null,
	workspaces: [],
	activeWorkspaceId: null,

	sidebar: "files",
	bottomVisible: true,
	bottomTab: "terminal",

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

	async boot(client) {
		set({ client });
		const hello = await client.request("app.hello", { protocolVersion: 1 });
		if (!hello.ok) {
			set((s) => ({ logs: [...s.logs, `协议协商失败:${hello.error}`] }));
			return;
		}
		set({ connected: true, hostName: hello.host, demo: hello.demo });
	},

	async openProject(path) {
		const { client, workspaces } = get();
		if (!client) return;
		const r = await client.request("project.open", { path });
		if (!r.ok) {
			set((s) => ({ logs: [...s.logs, `打开项目失败:${r.error}`] }));
			return;
		}
		set({
			project: { id: r.projectId, root: r.root, name: r.name, trusted: r.trusted, branch: r.branch },
		});
		const list = await client.request("workspace.list", { projectId: r.projectId });
		if (list.ok) {
			const wss: WorkspaceView[] = list.workspaces.map((w) => ({
				id: w.id,
				kind: w.kind,
				branch: w.branch,
				path: w.path,
			}));
			set({ workspaces: wss, activeWorkspaceId: list.activeWorkspaceId });
			// 初始会话挂到当前工作区
			const created = await client.request("session.create", {
				workspacePath: wss.find((w) => w.id === list.activeWorkspaceId)?.path ?? "",
				demoMode: get().demo,
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
	},

	async trustProject() {
		const { client, project } = get();
		if (!client || !project) return;
		const r = await client.request("project.trust", { projectId: project.id });
		if (r.ok) set((s) => ({ project: s.project ? { ...s.project, trusted: true } : s.project }));
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
				workspaces: list.workspaces.map((w) => ({ id: w.id, kind: w.kind, branch: w.branch, path: w.path })),
			});
		}
		// W4 原子换入:重建会话 + 终端清空 + 计划随工作区恢复
		const ws = get().workspaces.find((w) => w.id === id);
		const created = await client.request("session.create", {
			workspacePath: ws?.path ?? "",
			demoMode: get().demo,
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

	async createWorktree(name) {
		const { client, project } = get();
		if (!client || !project) return;
		const r = await client.request("workspace.create", { projectId: project.id, name });
		if (r.ok) {
			await get().switchWorkspace(r.workspaceId);
		} else {
			set((s) => ({ logs: [...s.logs, `创建工作区失败:${r.error}`] }));
		}
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

	async rebuild() {
		const { client, chat } = get();
		if (!client || !chat.sessionId) return;
		const r = await client.request("session.rebuild", { sessionId: chat.sessionId });
		if (!r.ok) return;
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
		// 4F:错误一键问 agent —— 切到对话页签,推入上下文芯片与问题
		const { client, activeWorkspaceId } = get();
		set({ activeTab: "chat" });
		if (client && activeWorkspaceId) {
			await client.request("session.askWithContext", { workspaceId: activeWorkspaceId, source, contextText, question });
		}
		set((st) => ({
			logs: [...st.logs, "[ctx] " + source + " · " + contextText.slice(0, 80)],
			chat: {
				...st.chat,
				messages: [
					...st.chat.messages,
					{ id: Math.random(), role: "user" as const, text: question + "\n(上下文:" + contextText.slice(0, 160) + ")" },
				],
			},
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
			const ds = await client.request("devserver.ensure", { workspaceId: activeWorkspaceId });
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
