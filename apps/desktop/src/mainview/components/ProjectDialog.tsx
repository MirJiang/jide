/** 项目信任确认对话框(W1;打开/切换项目走标题栏下拉,不再弹窗) */

import { useEffect } from "react";
import { useIDE } from "../store";
import { Icon } from "./Icon";

export function ProjectDialog() {
	const s = useIDE();

	// Esc 关闭(可随时从标题栏「项目」区再次唤起)
	useEffect(() => {
		if (!s.projectDialog) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") useIDE.getState().closeProjectDialog();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [s.projectDialog]);

	if (s.projectDialog === "trust" && s.project) {
		return (
			<Gate icon="ri-shield-check-line" title="信任此项目?" onClose={() => s.closeProjectDialog()}>
				<div className="my-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs" style={{ borderColor: "var(--line)", background: "var(--bg0)", color: "var(--yellow)" }}>
					<Icon name="ri-git-repository-line" size={13} />
					<span className="truncate">{s.project.root}</span>
				</div>
				<div className="mb-4 mt-2.5 text-xs leading-relaxed" style={{ color: "var(--fg-dim)" }}>
					<span className="flex items-start gap-1.5">
						<Icon name="ri-eye-line" size={13} className="mt-0.5" color="var(--fg-faint)" />
						信任前:只读浏览,禁止命令执行、文件写入与 agent 工具调用。
					</span>
					<span className="mt-1.5 flex items-start gap-1.5">
						<Icon name="ri-shield-keyhole-line" size={13} className="mt-0.5" color="var(--green)" />
						信任后:可创建隔离工作区、写文件、运行终端与计划自动提交。
					</span>
				</div>
				<button className="jide-btn w-full py-2.5 text-sm" onClick={() => void s.trustProject()}>
					<Icon name="ri-shield-check-line" size={14} />
					信任并继续
				</button>
				<button
					className="jide-btn-ghost mt-2 w-full py-2 text-xs"
					onClick={() => s.closeProjectDialog()}
				>
					暂不信任,仅浏览
				</button>
				<button
					className="mt-3 flex w-full items-center justify-center gap-1 text-[11px] underline underline-offset-2"
					style={{ color: "var(--fg-faint)" }}
					onClick={() => {
						useIDE.getState().closeProjectDialog();
						useIDE.getState().setProjectMenuOpen(true);
					}}
				>
					<Icon name="ri-folder-3-line" size={12} />
					切换其他项目…
				</button>
			</Gate>
		);
	}

	return null;
}

function Gate({ icon, title, children, onClose }: { icon: string; title: string; children: React.ReactNode; onClose: () => void }) {
	return (
		<div
			className="absolute inset-0 z-[100] flex items-center justify-center"
			style={{ background: "rgba(6,8,10,.72)", backdropFilter: "blur(3px)" }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="relative w-[460px] rounded-2xl border p-6"
				style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 30px 80px rgba(0,0,0,.6)" }}
			>
				<button
					className="absolute right-3 top-2.5 flex items-center rounded px-1.5 hover:text-[var(--fg)]"
					style={{ color: "var(--fg-faint)" }}
					title="关闭(Esc)"
					onClick={onClose}
				>
					<Icon name="ri-close-line" size={15} />
				</button>
				<div className="mb-3 flex items-center gap-2.5">
					<span
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{ background: "var(--acc-dim)", color: "var(--acc)" }}
					>
						<Icon name={icon} size={17} />
					</span>
					<span className="text-base font-semibold">{title}</span>
				</div>
				{children}
			</div>
		</div>
	);
}
