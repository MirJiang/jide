/** 顶栏(自定义标题栏):PixelJ logo + 分离 Git 状态条 + 工作区切换 + 运行入口 + 窗控 */

import { useState } from "react";
import { useIDE } from "../store";
import { PixelJ } from "./PixelJ";
import { Icon } from "./Icon";

export function TitleBar() {
	const s = useIDE();
	const [wsOpen, setWsOpen] = useState(false);
	const [stacked, setStacked] = useState(false);
	const [runOpen, setRunOpen] = useState(false);
	const [wtName, setWtName] = useState("");
	const [maximized, setMaximized] = useState(false);
	const [remoteUrl, setRemoteUrl] = useState("");
	const [targetDir, setTargetDir] = useState("");
	const [cloning, setCloning] = useState(false);
	const [pErr, setPErr] = useState("");
	const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
	const canOp = Boolean(s.project?.trusted);
	const busy = s.chat.status === "busy";
	const pOpen = s.projectMenuOpen;

	const pickFolder = async () => {
		setPErr("");
		const r = await s.client?.request("project.pickFolder", {});
		if (!r || !r.ok) {
			setPErr(r && !r.ok ? `无法打开目录选择器:${r.error}` : "未连接宿主");
			return;
		}
		if (!r.folder) return;
		const opened = await s.openProject(r.folder);
		if (!opened) setPErr(`打开失败:${r.folder} 不是 git 仓库(或路径不存在)`);
	};
	const cloneAndOpen = async () => {
		setPErr("");
		setCloning(true);
		const r = await s.client?.request("project.clone", { url: remoteUrl.trim(), dir: targetDir.trim() });
		setCloning(false);
		if (!r) setPErr("未连接宿主");
		else if (!r.ok) setPErr(r.error);
		else {
			const opened = await s.openProject(r.folder);
			if (!opened) setPErr("克隆成功,但打开失败(不是 git 仓库?)");
		}
	};

	const winCtl = async (action: "minimize" | "maximize" | "close") => {
		if (!s.client) return;
		if (action === "maximize") {
			const r = await s.client.request("window.toggleMaximize", {});
			if (r.ok) setMaximized(r.maximized);
		} else {
			await s.client.request(action === "minimize" ? "window.minimize" : "window.close", {});
		}
	};

	return (
		<header
			/* 无边框窗口:整条顶栏为拖拽区,交互子元素逐个 no-drag */
			className="jide-drag flex items-stretch justify-between px-1.5"
			style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)", height: 44 }}
		>
			<div className="flex items-stretch">
				<div className="jide-no-drag flex items-center px-2">
					<PixelJ cell={3} busy={busy} glow title="JIDE" />
				</div>
				<div className="relative flex items-stretch">
					<button
						className="jide-no-drag flex flex-col justify-center px-3 hover:brightness-110"
						style={{ borderRight: "1px solid var(--line)", cursor: "pointer" }}
						title={s.project ? (s.project.trusted ? "切换项目" : "项目未信任,点击确认") : "打开项目"}
						onClick={() => {
							setPErr("");
							s.setProjectMenuOpen(!pOpen);
						}}
					>
						<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>项目</span>
						<span className="flex items-center gap-1.5 text-xs font-medium">
							<Icon name="ri-folder-3-line" size={13} color={s.project ? undefined : "var(--acc)"} />
							{s.project?.name ?? <span style={{ color: "var(--acc)" }}>打开项目…</span>}
							{s.project && !s.project.trusted && (
								<span className="flex items-center gap-0.5 rounded px-1 text-[9px]" style={{ background: "var(--yellow-bg)", color: "var(--yellow)" }}>
									<Icon name="ri-shield-flash-line" size={10} />
									未信任
								</span>
							)}
						</span>
					</button>
					{pOpen && <div className="fixed inset-0 z-40" onClick={() => s.setProjectMenuOpen(false)} />}
					{pOpen && (
						<div
							className="jide-no-drag absolute left-0 top-[42px] z-50 w-[340px] rounded-lg border p-2"
							style={{ background: "var(--bg2)", borderColor: "var(--line2)", boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}
						>
							<div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
								<Icon name="ri-folder-open-line" size={11} />
								本地项目
							</div>
							<button
								className="jide-btn w-full py-1.5 text-xs"
								onClick={() => void pickFolder()}
							>
								<Icon name="ri-folder-open-line" size={13} />
								浏览本地目录…
							</button>
							<div className="mb-1 mt-3 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
								<Icon name="ri-git-repository-line" size={11} />
								远程 git 项目
							</div>
							<input
								value={remoteUrl}
								onChange={(e) => {
									setRemoteUrl(e.target.value);
									const name = e.target.value.split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
									if (name) setTargetDir((d) => (d ? d.replace(/[^\\/]+$/, name) : `C:\\code\\${name}`));
								}}
								placeholder="https://github.com/user/repo.git"
								className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none"
								style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
							/>
							<input
								value={targetDir}
								onChange={(e) => setTargetDir(e.target.value)}
								placeholder="克隆目标目录,如 C:\code\repo"
								className="mt-1.5 w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none"
								style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
							/>
							<button
								className="jide-btn-ghost mt-1.5 w-full py-1.5 text-xs"
								disabled={!remoteUrl.trim() || !targetDir.trim() || cloning}
								onClick={() => void cloneAndOpen()}
							>
								<Icon name={cloning ? "ri-loader-4-line" : "ri-download-cloud-line"} size={13} className={cloning ? "animate-spin" : undefined} />
								{cloning ? "克隆中…" : "克隆并打开"}
							</button>
							{pErr && (
								<div className="mt-1.5 flex items-center gap-1 px-1 text-[11px]" style={{ color: "var(--red)" }}>
									<Icon name="ri-error-warning-line" size={12} />
									{pErr}
								</div>
							)}
							{s.project && !s.project.trusted && (
								<>
									<div className="my-1.5 h-px" style={{ background: "var(--line)" }} />
									<button
										className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--bg3)]"
										style={{ color: "var(--yellow)" }}
										onClick={() => {
											s.setProjectMenuOpen(false);
											s.showProjectDialog();
										}}
									>
										<Icon name="ri-shield-check-line" size={13} />
										当前项目未信任,去确认…
									</button>
								</>
							)}
						</div>
					)}
				</div>
				<div className="relative flex items-stretch">
					<button
						className="jide-no-drag flex flex-col justify-center px-3 hover:brightness-110"
						style={{ borderRight: "1px solid var(--line)", cursor: "pointer" }}
						onClick={() => setWsOpen((v) => !v)}
					>
						<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>工作区</span>
						<span className="flex items-center gap-1 text-xs font-medium">
							<Icon name="ri-stack-line" size={13} />
							{active ? (active.kind === "default" ? `Default (${active.branch})` : active.branch) : "—"}
						</span>
					</button>
					{wsOpen && (
						<div className="fixed inset-0 z-40" onClick={() => setWsOpen(false)} />
					)}
					{wsOpen && (
						<div
							className="jide-no-drag absolute left-0 top-[42px] z-50 min-w-[280px] rounded-lg border p-1"
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
										<Icon name={w.kind === "default" ? "ri-git-repository-line" : "ri-git-branch-line"} size={13} color={w.kind === "default" ? undefined : "var(--green)"} />
										{w.kind === "default" ? `Default · ${w.branch}` : w.branch}
										{w.kind === "worktree" && (
											<span className="rounded px-1 text-[9px]" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
												隔离
											</span>
										)}
										{w.parentWorkspaceId && (
											<span className="rounded px-1 text-[9px]" style={{ background: "var(--purple-bg)", color: "var(--purple)" }} title={`stacked,基于 ${s.workspaces.find((x) => x.id === w.parentWorkspaceId)?.branch ?? w.parentWorkspaceId}`}>
												⎇ {s.workspaces.find((x) => x.id === w.parentWorkspaceId)?.branch ?? "父工作区"}
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
									新建隔离工作区(分支 jide/&lt;名称&gt;{stacked ? ",基于当前工作区分支(stacked)" : ",基于当前 HEAD"})
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
										className="jide-btn px-2 py-1 text-xs"
										disabled={!canOp || !wtName.trim()}
										title={canOp ? undefined : "未信任项目不能创建工作区"}
										onClick={async () => {
											if (!wtName.trim()) return;
											setWsOpen(false);
											await s.createWorktree(wtName.trim(), { stacked });
											setWtName("");
											setStacked(false);
										}}
									>
										<Icon name="ri-git-branch-line" size={12} />
										创建并切换
									</button>
								</div>
								<label className="mt-1.5 flex cursor-pointer items-center gap-1 text-[11px]" style={{ color: "var(--fg-dim)" }}>
									<input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} />
									基于当前工作区创建子工作区(stacked 血缘,合并须先合父级)
								</label>
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
						<Icon name="ri-git-branch-line" size={13} color="var(--acc)" />
						{s.git.branch || "—"}
					</span>
				</div>
				<div className="flex flex-col justify-center px-3" style={{ borderRight: "1px solid var(--line)" }}>
					<span className="text-[9.5px]" style={{ color: "var(--fg-faint)" }}>变更</span>
					<span className="flex items-center gap-1 text-xs font-medium">
						<Icon name="ri-file-edit-line" size={13} color={s.git.changes.length ? "var(--yellow)" : undefined} />
						{s.git.changes.length || "—"}
					</span>
				</div>
				{/* 独立操作按钮(§6):同步(fetch --all)与拉取请求(远端 compare) */}
				<button
					className="jide-no-drag flex items-center gap-1.5 px-3 text-xs hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-dim)", borderRight: "1px solid var(--line)" }}
					title="git fetch --all + 状态刷新"
					onClick={async () => {
						if (!s.client || !s.activeWorkspaceId) return;
						const r = await s.client.request("git.sync", { workspaceId: s.activeWorkspaceId });
						useIDE.setState((st) => ({
							logs: [...st.logs, r.ok ? `已同步(fetch=${r.fetched},↑${r.ahead} ↓${r.behind})` : `同步失败:${r.error}`],
						}));
						void s.refreshGit();
					}}
				>
					<Icon name="ri-refresh-line" size={13} />
					同步
				</button>
				<button
					className="jide-no-drag flex items-center gap-1.5 px-3 text-xs hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-dim)", borderRight: "1px solid var(--line)" }}
					title="在远端创建拉取请求(compare 页)"
					onClick={async () => {
						if (!s.client || !s.activeWorkspaceId) return;
						const r = await s.client.request("git.openPullRequest", { workspaceId: s.activeWorkspaceId });
						if (!r.ok) useIDE.setState((st) => ({ logs: [...st.logs, `拉取请求:${r.error}`] }));
					}}
				>
					<Icon name="ri-git-pull-request-line" size={13} />
					拉取请求
				</button>
			</div>

			<div className="jide-no-drag flex items-center gap-2 pr-1">
				<button
					className="jide-btn-ghost px-2.5 py-1.5 text-[13px]"
					title="设置"
					onClick={() => s.setSettingsOpen(true)}
				>
					<Icon name="ri-settings-3-line" size={14} />
				</button>
				<div className="relative">
					<button
						className="jide-btn px-3 py-1.5 text-xs"
						onClick={() => setRunOpen((v) => !v)}
					>
						<Icon name="ri-play-fill" size={13} />
						运行
						<Icon name="ri-arrow-down-s-line" size={12} className="opacity-70" />
					</button>
					{runOpen && <div className="fixed inset-0 z-40" onClick={() => setRunOpen(false)} />}
					{runOpen && (
						<div className="jide-no-drag absolute right-0 top-[36px] z-50 min-w-[300px] rounded-lg border p-1" style={{ background: "var(--bg2)", borderColor: "var(--line2)", boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
							<RunMenuItem
								icon="ri-flask-line"
								label="① Agent 自测"
								desc="后台静默跑选测 + 检查项,不打扰当前视图"
								onClick={async () => {
									setRunOpen(false);
									await s.runTier("agent");
								}}
							/>
							<RunMenuItem
								icon="ri-global-line"
								label="② 人侧运行 + 预览"
								desc="起 dev server 并打开内嵌预览(与 agent 共引擎)"
								onClick={async () => {
									setRunOpen(false);
									await s.runTier("human");
								}}
							/>
							<RunMenuItem
								icon="ri-terminal-box-line"
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

				{/* 窗口控制(无边框自定义 chrome) */}
				<div className="ml-1 flex items-center gap-1">
					<button className="win-btn" title="最小化" onClick={() => void winCtl("minimize")}>
						<Icon name="ri-subtract-line" size={13} />
					</button>
					<button className="win-btn" title={maximized ? "还原" : "最大化"} onClick={() => void winCtl("maximize")}>
						<Icon name={maximized ? "ri-picture-in-picture-2-line" : "ri-checkbox-blank-line"} size={11} />
					</button>
					<button className="win-btn win-close" title="关闭" onClick={() => void winCtl("close")}>
						<Icon name="ri-close-line" size={13} />
					</button>
				</div>
			</div>
		</header>
	);
}


function RunMenuItem({ icon, label, desc, onClick }: { icon: string; label: string; desc: string; onClick: () => void }) {
	return (
		<button className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg3)]" onClick={onClick}>
			<Icon name={icon} size={15} className="mt-0.5" color="var(--acc)" />
			<span className="flex flex-col gap-0.5">
				<span className="text-xs font-medium">{label}</span>
				<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>{desc}</span>
			</span>
		</button>
	);
}
