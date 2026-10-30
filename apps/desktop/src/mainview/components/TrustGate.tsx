/** 项目打开 + 信任门(W1):未打开项目或未信任时的全屏门禁 */

import { useState } from "react";
import { useIDE } from "../store";

export function TrustGate() {
	const s = useIDE();
	const [path, setPath] = useState("");
	const [err, setErr] = useState("");

	if (s.project?.trusted) return null;

	if (!s.project) {
		return (
			<Gate>
				<div className="text-base font-semibold">打开项目</div>
				<div className="mb-4 mt-1 text-xs leading-relaxed" style={{ color: "var(--fg-dim)" }}>
					Project = 一个 git 仓库。首次打开需要显式信任(W1),信任前只读浏览。
				</div>
				<input
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
			</Gate>
		);
	}

	return (
		<Gate>
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
		</Gate>
	);
}

function Gate({ children }: { children: React.ReactNode }) {
	return (
		<div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "rgba(8,10,14,.72)", backdropFilter: "blur(3px)" }}>
			<div
				className="w-[460px] rounded-2xl border p-6"
				style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 30px 80px rgba(0,0,0,.6)" }}
			>
				{children}
			</div>
		</div>
	);
}
