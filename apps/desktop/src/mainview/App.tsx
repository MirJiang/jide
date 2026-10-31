/**
 * JIDE 主界面 — 原型冻结布局(business-design §6):
 * 标题栏(Git 状态条)| 活动栏 | 侧栏 | 内容区页签(Agent 对话默认 + 文件)+ 底部面板 | 计划停靠 | 状态栏
 */

import { useEffect, useRef } from "react";
import { useIDE, tabKey } from "./store";
import { connect } from "./rpc";
import { TitleBar } from "./components/TitleBar";
import { ActivityBar, SidebarPanel } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { CodeEditor } from "./components/CodeEditor";
import { DiffView } from "./components/DiffView";
import { TerminalView } from "./components/TerminalView";
import { WorkflowDock } from "./components/WorkflowDock";
import { TestPanel, ChecksPanel } from "./components/TestPanels";
import { StatusBar } from "./components/StatusBar";
import { TrustGate } from "./components/TrustGate";

export default function App() {
	const s = useIDE();
	const bootedRef = useRef(false);

	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		const client = connect((event) => useIDE.getState().handleEvent(event));
		client.resync(0);
		useIDE
			.getState()
			.boot(client)
			.then(async () => {
				// 宿主可能在 UI 就绪前已产生事件(smoke 钩子/后台任务):
				// 连接建立后按当前 seq 补拉一次,保证 journal 不漏
				client.resync(useIDE.getState().lastSeq);
				// 开发便利:JIDE_DEV_PROJECT 环境变量自动打开项目
				const dev = process.env.JIDE_DEV_PROJECT;
				if (dev) await useIDE.getState().openProject(dev);
			})
			.catch((err) => {
				useIDE.setState((st) => ({ logs: [...st.logs, `连接失败:${err}`] }));
			});
	}, []);

	const activeFile = s.tabs.find((t) => t.kind === "file" && t.path === s.activeTab);

	return (
		<div className="flex h-full flex-col" style={{ background: "var(--bg0)" }}>
			<TitleBar />
			<div className="flex min-h-0 flex-1">
				<ActivityBar />
				<SidebarPanel />
				<section className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg0)" }}>
					{/* 内容区页签 */}
					<div
						className="flex h-[35px] items-stretch overflow-x-auto"
						style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}
					>
						{s.tabs.map((t) => {
							const key = tabKey(t);
							const active = s.activeTab === key;
							return (
								<div
									key={key}
									className="group flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-3.5 text-xs"
									onClick={() => s.setActiveTab(key)}
									style={{
										borderRight: "1px solid var(--line)",
										color: active ? "var(--fg)" : "var(--fg-faint)",
										background: active ? "var(--bg0)" : undefined,
										position: "relative",
									}}
								>
									{active && <div className="absolute left-0 right-0 top-0 h-0.5" style={{ background: "var(--acc)" }} />}
									{t.kind === "chat" ? (
										<span style={{ color: "var(--acc)" }}>✦</span>
									) : (
										<span>{t.dirty ? "●" : "▯"}</span>
									)}
									{t.title}
									{t.dirty && <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--yellow)" }} />}
									{t.spotted && <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--green)" }} />}
									{t.kind === "file" && (
										<button
											className="ml-1 opacity-0 group-hover:opacity-100"
											style={{ color: "var(--fg-faint)" }}
											onClick={(e) => {
												e.stopPropagation();
												s.closeTab(key);
											}}
										>
											×
										</button>
									)}
								</div>
							);
						})}
						{activeFile?.dirty && (
							<button
								className="my-1 ml-auto mr-2 flex-none self-center rounded border px-2 py-0.5 text-[11px]"
								style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
								onClick={() => void s.saveActiveTab()}
							>
								保存 ⌘S
							</button>
						)}
					</div>

					{/* 视图区 */}
					<div className="relative min-h-0 flex-1">
						<div className="absolute inset-0" style={{ display: s.activeTab === "chat" ? "block" : "none" }}>
							<ChatPanel />
						</div>
						{s.tabs.filter((t) => t.kind === "diff").map((t) => (
							<div key={tabKey(t)} className="absolute inset-0" style={{ display: s.activeTab === tabKey(t) ? "block" : "none" }}>
								<DiffView path={t.path!} />
							</div>
						))}
						{activeFile && (
							<div className="absolute inset-0" style={{ display: s.activeTab === activeFile.path ? "block" : "none" }}>
								<CodeEditor key={activeFile.path} path={activeFile.path!} content={activeFile.content ?? ""} />
							</div>
						)}
					</div>

					{/* 底部面板 */}
					{s.bottomVisible && (
						<div
							className="flex h-[225px] flex-none flex-col"
							style={{ borderTop: "1px solid var(--line)", background: "var(--bg0)" }}
						>
							<div
								className="flex h-[32px] flex-none items-stretch"
								style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}
							>
								{(
									[
										["terminal", "终端"],
										["tests", "测试"],
										["checks", "检查项"],
									] as const
								).map(([id, label]) => (
									<button
										key={id}
										className="relative flex items-center gap-1.5 px-4 text-xs"
										style={{
											borderRight: "1px solid var(--line)",
											color: s.bottomTab === id ? "var(--fg)" : "var(--fg-faint)",
										}}
										onClick={() => s.setBottomTab(id)}
									>
										{label}
										{s.bottomTab === id && (
											<div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: "var(--acc)" }} />
										)}
									</button>
								))}
							</div>
							<div className="relative min-h-0 flex-1">
								{s.bottomTab === "terminal" && <TerminalView />}
								{s.bottomTab === "tests" && <TestPanel />}
								{s.bottomTab === "checks" && <ChecksPanel />}
							</div>
						</div>
					)}
				</section>
				<WorkflowDock />
			</div>
			<StatusBar />
			<TrustGate />
			<style>{`
				@keyframes jide-pulse{0%,100%{opacity:1}50%{opacity:.35}}
				@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
			`}</style>
		</div>
	);
}
