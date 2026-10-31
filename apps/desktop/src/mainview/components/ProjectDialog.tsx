/** 项目对话框(W1):打开项目 / 信任确认。可关闭(×/Esc/暂不打开),启动不再强制选择项目 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";

export function ProjectDialog() {
	const s = useIDE();
	const [path, setPath] = useState("");
	const [err, setErr] = useState("");

	// Esc 关闭(可随时从标题栏「项目」区再次唤起)
	useEffect(() => {
		if (!s.projectDialog) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") useIDE.getState().closeProjectDialog();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [s.projectDialog]);

	if (s.projectDialog === "open") {
		return (
			<Gate onClose={() => s.closeProjectDialog()}>
				<div className="text-base font-semibold">打开项目</div>
				<div className="mb-4 mt-1 text-xs leading-relaxed" style={{ color: "var(--fg-dim)" }}>
					Project = 一个 git 仓库。首次打开需要显式信任(W1),信任前只读浏览。
				</div>
				<input
					autoFocus
					value={path}
					onChange={(e) => setPath(e.target.value)}
					placeholder="C:\path\to\repo"
					className="mb-3 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none"
					style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
					onKeyDown={(e) => {
						if (e.key === "Enter" && path.trim()) {
							setErr("");
							void s.openProject(path.trim());
						}
					}}
				/>
				{err && <div className="mb-2 text-xs" style={{ color: "var(--red)" }}>{err}</div>}
				<button
					className="w-full rounded-md border py-2 text-sm font-medium"
					style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#dbe7ff" }}
					onClick={async () => {
						setErr("");
						await s.openProject(path.trim());
						if (!useIDE.getState().project) setErr("打开失败:请确认路径是 git 仓库");
					}}
				>
					打开项目
				</button>
				<button
					className="mt-2 w-full rounded-md border py-2 text-xs"
					style={{ borderColor: "var(--line)", color: "var(--fg-faint)" }}
					onClick={() => s.closeProjectDialog()}
				>
					暂不打开,先逛逛
				</button>
			</Gate>
		);
	}

	if (s.projectDialog === "trust" && s.project) {
		return (
			<Gate onClose={() => s.closeProjectDialog()}>
				<div className="text-base font-semibold">信任此项目?</div>
				<div className="my-1 font-mono text-xs" style={{ color: "var(--yellow)" }}>{s.project.root}</div>
				<div className="mb-4 mt-2 text-xs leading-relaxed" style={{ color: "var(--fg-dim)" }}>
					信任前:只读浏览,禁止命令执行、文件写入与 agent 工具调用。
					<br />
					信任后:可创建隔离工作区、写文件、运行终端与计划自动提交。
				</div>
				<button
					className="w-full rounded-md border py-2 text-sm font-medium"
					style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#dbe7ff" }}
					onClick={() => void s.trustProject()}
				>
					信任并继续
				</button>
				<button
					className="mt-2 w-full rounded-md border py-2 text-xs"
					style={{ borderColor: "var(--line)", color: "var(--fg-faint)" }}
					onClick={() => s.closeProjectDialog()}
				>
					暂不信任,仅浏览
				</button>
				<button
					className="mt-3 w-full text-[11px] underline underline-offset-2"
					style={{ color: "var(--fg-faint)" }}
					onClick={() => useIDE.setState({ projectDialog: "open" })}
				>
					打开其他项目…
				</button>
			</Gate>
		);
	}

	return null;
}

function Gate({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
	return (
		<div
			className="absolute inset-0 z-[100] flex items-center justify-center"
			style={{ background: "rgba(8,10,14,.72)", backdropFilter: "blur(3px)" }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="relative w-[460px] rounded-2xl border p-6"
				style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 30px 80px rgba(0,0,0,.6)" }}
			>
				<button
					className="absolute right-3 top-2.5 rounded px-1.5 text-sm"
					style={{ color: "var(--fg-faint)" }}
					title="关闭(Esc)"
					onClick={onClose}
				>
					×
				</button>
				{children}
			</div>
		</div>
	);
}
