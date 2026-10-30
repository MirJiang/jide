/** 状态栏:信任 / 工作区 / 终端开关 / 会话 / seq */

import { useIDE } from "../store";

export function StatusBar() {
	const s = useIDE();
	return (
		<footer
			className="flex h-[25px] items-center gap-4 px-2.5 text-[11.5px]"
			style={{ background: "var(--bg1)", borderTop: "1px solid var(--line)", color: "var(--fg-dim)" }}
		>
			<span className="flex items-center gap-1" title="信任门(W1):未信任前只读">
				{!s.project ? "—" : s.project.trusted ? "🛡 已信任" : "🛡 未信任(只读)"}
			</span>
			{s.activeWorkspaceId && (
				<span className="truncate" style={{ color: "var(--fg-faint)", maxWidth: 260 }} title={s.activeWorkspaceId}>
					{s.activeWorkspaceId.split(":").slice(1).join(" ") || "default"}
				</span>
			)}
			<div className="ml-auto flex items-center gap-4">
				<button onClick={() => s.toggleBottom()} title="切换底部面板">
					{s.bottomVisible ? "▾ 面板" : "▴ 面板"}
				</button>
				<span className="flex items-center gap-1">
					<span
						className="inline-block h-2 w-2 rounded-full"
						style={{ background: s.chat.status === "busy" ? "var(--green)" : "var(--fg-faint)" }}
					/>
					{s.chat.status === "busy" ? "agent 运行中" : "agent 空闲"}
				</span>
				<span style={{ color: "var(--fg-faint)" }}>seq {s.lastSeq}</span>
			</div>
		</footer>
	);
}
