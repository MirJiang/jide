/** 状态栏:信任 / 工作区 / 终端开关 / 会话(PixelJ)/ 记忆预算 */

import { useIDE } from "../store";
import { PixelJ } from "./PixelJ";

export function StatusBar() {
	const s = useIDE();
	const busy = s.chat.status === "busy";
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
				<span className="flex items-center gap-1.5" title={busy ? "agent 运行中" : "agent 空闲"}>
					<PixelJ cell={1.5} busy={busy} title={busy ? "agent 运行中" : "agent 空闲"} />
					{busy ? "agent 运行中" : "agent 空闲"}
				</span>
				<span style={{ color: "var(--fg-faint)" }}>seq {s.lastSeq}</span>
				<span className="flex items-center gap-1" title={"三级注入:项目 " + s.memoryBudget.projectK + "K · 用户 " + s.memoryBudget.userK + "K · 会话 " + s.memoryBudget.sessionK + "K"}>
					✦ 记忆 {s.memoryBudget.totalK} / {s.memoryBudget.capK}K{s.memoryBudget.nearLimit ? " ⚠" : ""}
				</span>
			</div>
		</footer>
	);
}
