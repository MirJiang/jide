/** 左侧:活动栏 + 面板(文件树 / 搜索占位 / Git / 记忆占位) */

import { useEffect, useState } from "react";
import { useIDE } from "../store";

const PANEL_TITLES: Record<string, string> = {
	files: "资源管理器",
	search: "搜索",
	git: "源代码管理",
	memory: "记忆",
};

function FileTree() {
	const s = useIDE();
	const [tree, setTree] = useState<Record<string, Array<{ name: string; kind: "file" | "dir" }>>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

	const load = async (dir: string) => {
		if (!s.client || !s.activeWorkspaceId) return;
		const r = await s.client.request("fs.list", { workspaceId: s.activeWorkspaceId, relPath: dir });
		if (r.ok) setTree((t) => ({ ...t, [dir]: r.entries }));
	};

	useEffect(() => {
		setTree({});
		setExpanded(new Set([""]));
		void load("");
	}, [s.activeWorkspaceId]);

	useEffect(() => {
		if (expanded.size && !tree[""]) void load("");
	}, [expanded]);

	const renderDir = (dir: string, depth: number): React.ReactNode =>
		(tree[dir] ?? [])
			.filter((e) => expanded.has(dir) || dir === "")
			.map((e) => {
				const rel = dir ? `${dir}/${e.name}` : e.name;
				if (e.kind === "dir") {
					const open = expanded.has(rel);
					return (
						<div key={rel}>
							<button
								className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-xs hover:bg-[var(--bg2)]"
								style={{ paddingLeft: 8 + depth * 14, color: "var(--fg-dim)" }}
								onClick={() => {
									setExpanded((prev) => {
										const n = new Set(prev);
										if (n.has(rel)) n.delete(rel);
										else n.add(rel);
										return n;
									});
									if (!open) void load(rel);
								}}
							>
								<span style={{ color: "var(--fg-faint)" }}>{open ? "▾" : "▸"}</span> {e.name}
							</button>
							{open && renderDir(rel, depth + 1)}
						</div>
					);
				}
				const gitChange = s.git.changes.find((c) => c.path === rel);
				return (
					<button
						key={rel}
						className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-xs hover:bg-[var(--bg2)]"
						style={{
							paddingLeft: 8 + depth * 14 + 14,
							color: s.activeTab === rel ? "#dbe7ff" : "var(--fg-dim)",
							background: s.activeTab === rel ? "var(--acc-dim)" : undefined,
						}}
						onClick={() => void s.openFile(rel)}
					>
						<span className="flex-1 truncate">{e.name}</span>
						{gitChange && (
							<span
								className="font-mono text-[10px]"
								style={{ color: gitChange.kind === "A" ? "var(--green)" : "var(--yellow)" }}
							>
								{gitChange.kind}
							</span>
						)}
					</button>
				);
			});

	return (
		<div className="pb-2">
			{!s.project && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--fg-faint)" }}>打开项目后显示文件树</div>}
			{renderDir("", 0)}
		</div>
	);
}

function GitPanel() {
	const s = useIDE();
	return (
		<div className="pb-2">
			<div className="px-3 pt-2 pb-1 text-xs font-medium">变更({s.git.changes.length})</div>
			{s.git.changes.map((c) => (
				<button
					key={c.path}
					className="flex w-full items-center gap-2 px-3 py-[3px] text-left text-xs hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-dim)" }}
					onClick={() => void s.openFile(c.path)}
				>
					<span className="flex-1 truncate font-mono">{c.path}</span>
					<span className="font-mono text-[10px]" style={{ color: c.kind === "A" ? "var(--green)" : c.kind === "D" ? "var(--red)" : "var(--yellow)" }}>
						{c.kind}
					</span>
				</button>
			))}
			{s.git.changes.length === 0 && (
				<div className="px-3 py-1 text-[11px]" style={{ color: "var(--fg-faint)" }}>无变更</div>
			)}
			<div className="px-3 pt-3 pb-1 text-xs font-medium">提交记录</div>
			{s.git.commits.map((c) => (
				<div key={c.shortSha} className="flex gap-2 px-2 py-1.5 hover:bg-[var(--bg2)]" style={{ marginLeft: 2 }}>
					<div className="relative" style={{ width: 14 }}>
						<div className="absolute left-[6px] top-[-6px] bottom-[-6px] w-[2px]" style={{ background: "var(--line2)" }} />
						<div
							className="absolute left-[2px] top-[7px] h-2 w-2 rounded-full"
							style={{ background: c.isAgent ? "var(--purple)" : "var(--acc)", boxShadow: "0 0 0 1.5px var(--bg1)" }}
						/>
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="font-mono text-[10.5px]" style={{ color: "var(--yellow)" }}>{c.shortSha}</span>
							{c.isAgent && (
								<span className="rounded px-1 text-[9px]" style={{ background: "var(--purple-bg)", color: "var(--purple)" }}>Agent</span>
							)}
						</div>
						<div className="truncate text-[11.5px]" title={c.message}>{c.message}</div>
						<div className="text-[10px]" style={{ color: "var(--fg-faint)" }}>
							{c.author} · {new Date(c.date).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

export function ActivityBar() {
	const sidebar = useIDE((s) => s.sidebar);
	const setSidebar = useIDE((s) => s.setSidebar);
	const changes = useIDE((s) => s.git.changes.length);
	const items: Array<{ id: typeof sidebar; label: string; icon: string; badge?: number }> = [
		{ id: "files", label: "资源管理器", icon: "◧" },
		{ id: "search", label: "搜索", icon: "⌕" },
		{ id: "git", label: "源代码管理", icon: "⎇", badge: changes || undefined },
		{ id: "memory", label: "记忆(M4)", icon: "▤" },
	];
	return (
		<nav
			className="flex w-[46px] flex-col items-center gap-1 pt-1.5"
			style={{ background: "var(--bg1)", borderRight: "1px solid var(--line)" }}
		>
			{items.map((it) => (
				<button
					key={it.id}
					title={it.label}
					className="relative flex h-[38px] w-[38px] items-center justify-center rounded-lg"
					style={{
						color: sidebar === it.id ? "var(--acc)" : "var(--fg-faint)",
						background: sidebar === it.id ? "var(--bg2)" : undefined,
					}}
					onClick={() => setSidebar(it.id)}
				>
					<span className="text-lg leading-none">{it.icon}</span>
					{it.badge ? (
						<span
							className="absolute right-1 top-1 rounded-full px-1 text-[9px] font-bold"
							style={{ background: "var(--acc)", color: "#0d1420", minWidth: 14 }}
						>
							{it.badge}
						</span>
					) : null}
				</button>
			))}
		</nav>
	);
}

export function SidebarPanel() {
	const sidebar = useIDE((s) => s.sidebar);
	return (
		<aside
			className="flex w-[252px] flex-col"
			style={{ background: "var(--bg1)", borderRight: "1px solid var(--line)" }}
		>
			<div
				className="flex h-[34px] items-center px-3 text-[11px] font-semibold"
				style={{ letterSpacing: 1.5, color: "var(--fg-dim)" }}
			>
				{PANEL_TITLES[sidebar]}
			</div>
			<div className="flex-1 overflow-y-auto">
				{sidebar === "files" && <FileTree />}
				{sidebar === "git" && <GitPanel />}
				{sidebar === "search" && (
					<div className="px-3 py-3 text-[11px]" style={{ color: "var(--fg-faint)" }}>
						搜索在 M2 后续版本实装(编辑器内 Ctrl+F 可用)。
					</div>
				)}
				{sidebar === "memory" && (
					<div className="px-3 py-3 text-[11px]" style={{ color: "var(--fg-faint)" }}>
						记忆域在 M4 实装(建议卡片 / 三级注入 / 整理)。
					</div>
				)}
			</div>
		</aside>
	);
}
