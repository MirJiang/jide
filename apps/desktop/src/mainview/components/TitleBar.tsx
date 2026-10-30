/** 顶栏:logo + 分离 Git 状态条 + 工作区切换 + 运行入口(M3 实装) */

import { useState } from "react";
import { useIDE } from "../store";

export function TitleBar() {
	const s = useIDE();
	const [wsOpen, setWsOpen] = useState(false);
	const [runOpen, setRunOpen] = useState(false);
	const [wtName, setWtName] = useState("");
	const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
	const canOp = Boolean(s.project?.trusted);

	return (
		<header
			className="flex items-stretch justify-between px-1.5"
			style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)", height: 44 }}
		>
			<div className="flex items-stretch">
				<div className="flex items-center gap-1.5 px-1 font-semibold tracking-wide" style={{ color: "var(--acc)" }}>
					JIDE
				</div>
				<div className="flex flex-col justify-center px-3" style={{ borderRight: "1px solid var(--line)" }}>
					<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>项目</span>
					<span className="text-xs font-medium">{s.project?.name ?? "未打开"}</span>
				</div>
				<div className="relative flex items-stretch">
					<button
						className="flex flex-col justify-center px-3 hover:brightness-110"
						style={{ borderRight: "1px solid var(--line)", cursor: "pointer" }}
						onClick={() => setWsOpen((v) => !v)}
					>
						<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>工作区</span>
						<span className="flex items-center gap-1 text-xs font-medium">
							{active ? (active.kind === "default" ? `Default (${active.branch})` : `${active.branch} ⛁`) : "—"}
						</span>
					</button>
					{wsOpen && (
						<div
							className="absolute left-0 top-[42px] z-50 min-w-[280px] rounded-lg border p-1"
							style={{ background: "var(--bg2)", borderColor: "var(--line2)", boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}
						>
							{s.workspaces.map((w) => (
								<button
									key={w.id}
									className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg3)]"
									onClick={() => {
										setWsOpen(false);
										void s.switchWorkspace(w.id);
									}}
								>
									<span className="flex items-center gap-2 text-xs font-medium">
										{w.kind === "default" ? `Default · ${w.branch}` : w.branch}
										{w.kind === "worktree" && (
											<span className="rounded px-1 text-[9px]" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
												隔离
											</span>
										)}
										{w.id === s.activeWorkspaceId && (
											<span className="text-[9px]" style={{ color: "var(--acc)" }}>● 当前</span>
										)}
									</span>
									<span className="truncate text-[11px]" style={{ color: "var(--fg-faint)" }}>{w.path}</span>
								</button>
							))}
							<div style={{ borderTop: "1px solid var(--line)", margin: "4px 6px" }} />
							<div className="px-2.5 py-1.5" disabled={!canOp}>
								<div className="mb-1 text-[11px]" style={{ color: "var(--fg-faint)" }}>
									新建隔离工作区(分支 jide/&lt;名称&gt;,基于当前 HEAD)
								</div>
								<div className="flex gap-1.5">
									<input
										value={wtName}
										onChange={(e) => setWtName(e.target.value)}
										placeholder="名称,如 cart-fix"
										className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs outline-none"
										style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
									/>
									<button
										className="rounded border px-2 py-1 text-xs disabled:opacity-40"
										style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
										disabled={!canOp || !wtName.trim()}
										title={canOp ? undefined : "未信任项目不能创建工作区"}
										onClick={async () => {
											if (!wtName.trim()) return;
											setWsOpen(false);
											await s.createWorktree(wtName.trim());
											setWtName("");
										}}
									>
										创建并切换
									</button>
								</div>
							</div>
							<div className="px-2.5 py-1.5 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
								工作区 = Project 下的 worktree;会话/终端随工作区原子切换(W4)
							</div>
						</div>
					)}
				</div>
				<div className="flex flex-col justify-center px-3" style={{ borderRight: "1px solid var(--line)" }}>
					<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>分支</span>
					<span className="flex items-center gap-1 text-xs font-medium">
						<span style={{ color: "var(--green)" }}>⎇</span>
						{s.git.branch || "—"}
					</span>
				</div>
				<div className="flex flex-col justify-center px-3" style={{ borderRight: "1px solid var(--line)" }}>
					<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>变更</span>
					<span className="text-xs font-medium">{s.git.changes.length || "—"}</span>
				</div>
			</div>

			<div className="flex items-center gap-2 pr-1">
				<div className="relative">
					<button
						className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium"
						style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#dbe7ff" }}
						onClick={() => setRunOpen((v) => !v)}
					>
						▶ 运行 ▾
					</button>
					{runOpen && (
						<div className="absolute right-0 top-[36px] z-50 min-w-[300px] rounded-lg border p-1" style={{ background: "var(--bg2)", borderColor: "var(--line2)" }}>
							<RunMenuItem
								label="① Agent 自测"
								desc="后台静默跑选测 + 检查项,不打扰当前视图"
								onClick={async () => {
									setRunOpen(false);
									await s.runTier("agent");
								}}
							/>
							<RunMenuItem
								label="② 人侧运行 + 预览"
								desc="起 dev server 并打开内嵌预览(与 agent 共引擎)"
								onClick={async () => {
									setRunOpen(false);
									await s.runTier("human");
								}}
							/>
							<RunMenuItem
								label="③ 调试(CDP 后门)"
								desc="附着 CDP;断点调试器为非目标,仅协议后门"
								onClick={async () => {
									setRunOpen(false);
									await s.runTier("cdp");
								}}
							/>
						</div>
					)}
				</div>
			</div>
		</header>
	);
}


function RunMenuItem({ label, desc, onClick }: { label: string; desc: string; onClick: () => void }) {
	return (
		<button className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg3)]" onClick={onClick}>
			<span className="text-xs font-medium">{label}</span>
			<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>{desc}</span>
		</button>
	);
}
