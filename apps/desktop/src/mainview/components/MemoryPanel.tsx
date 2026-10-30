/** 记忆面板(M4):预算水位/条目/整理回退/AGENTS.md 边界 + 对话内建议卡片 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";

export function MemoryPanel() {
	const s = useIDE();
	const [entries, setEntries] = useState<Array<{ scope: "project" | "user"; file: string; source: string; lines: string[]; lastHit?: string }>>([]);
	const [budget, setBudget] = useState(s.memoryBudget);
	const [tidyInfo, setTidyInfo] = useState<string>("");

	const refresh = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		const r = await s.client.request("memory.status", { workspaceId: s.activeWorkspaceId });
		if (r.ok) {
			setEntries(r.entries);
			setBudget(r.budget);
		}
	};

	useEffect(() => {
		void refresh();
	}, [s.activeWorkspaceId, s.memoryBudget.totalK]);

	const tidy = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		const r = await s.client.request("memory.tidy", { workspaceId: s.activeWorkspaceId });
		if (r.ok) setTidyInfo(`整理完成:${r.before} → ${r.after} 条(重复已合并${r.changed.length ? ",.bak 已留档" : ""})`);
		void refresh();
	};
	const revert = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		const r = await s.client.request("memory.revertTidy", { workspaceId: s.activeWorkspaceId });
		if (r.ok) setTidyInfo(`已回退整理(恢复 ${r.restored} 个文件)`);
		void refresh();
	};

	return (
		<div className="pb-3">
			<div className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: "var(--line)" }}>
				<div className="flex items-center justify-between text-xs">
					<span>注入预算(三级)</span>
					<span className="font-mono">
						{budget.totalK} / {budget.capK}K
					</span>
				</div>
				<div className="mt-1.5 h-[5px] overflow-hidden rounded" style={{ background: "#2a3040" }}>
					<div
						className="h-full rounded"
						style={{ width: Math.min(100, (budget.totalK / budget.capK) * 100) + "%", background: budget.nearLimit ? "var(--yellow)" : "linear-gradient(90deg,var(--acc),var(--purple))" }}
					/>
				</div>
				<div className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
					项目层 {budget.projectK}K · 用户层 {budget.userK}K · 会话层 {budget.sessionK}K
					{budget.nearLimit && <span style={{ color: "var(--yellow)" }}> · 接近上限,建议整理</span>}
				</div>
			</div>
			<div className="flex gap-1.5 px-2.5 pb-1">
				<button onClick={() => void tidy()} className="flex-1 rounded border border-dashed px-2 py-1 text-xs" style={{ borderColor: "var(--line2)", color: "var(--fg-dim)" }}>
					整理(合并重复 / 遗忘过时)
				</button>
				<button onClick={() => void revert()} className="rounded border px-2 py-1 text-xs" style={{ borderColor: "var(--line)", color: "var(--fg-faint)" }}>
					回退
				</button>
			</div>
			{tidyInfo && <div className="px-3 pb-1 text-[11px]" style={{ color: "var(--green)" }}>{tidyInfo}</div>}
			{entries.map((e) => (
				<button
					key={`${e.scope}/${e.file}`}
					className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-dim)" }}
					onClick={() => void s.client?.request("memory.recall", { workspaceId: s.activeWorkspaceId!, keywords: [e.lines[0]?.slice(0, 6) ?? ""] })}
				>
					<span className="flex-1 truncate">{e.file}</span>
					<span className="rounded px-1 text-[10px]" style={e.scope === "project" ? { background: "var(--purple-bg)", color: "var(--purple)" } : { background: "rgba(251,146,60,.12)", color: "var(--orange)" }}>
						{e.scope === "project" ? "项目层" : "用户层"}
					</span>
					<span className="font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>{e.lines.length} 条</span>
				</button>
			))}
			{!entries.length && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--fg-faint)" }}>暂无记忆。任务完成时会收到建议卡片。</div>}
			<div className="mx-2.5 mt-2 rounded-lg border p-2.5 text-[11px] leading-relaxed" style={{ background: "var(--bg0)", borderColor: "var(--line)", color: "var(--fg-faint)" }}>
				<div className="font-mono" style={{ color: "var(--fg)" }}>AGENTS.md</div>
				仅用户手写,记忆系统只读不写(边界)。
			</div>
		</div>
	);
}

/** 对话流中的建议卡片(三动作:采纳 / 忽略 / 改后采纳) */
export function MemorySuggestionCard({ suggestion }: { suggestion: { suggestionId: string; file: string; lines: string[]; reason: string } }) {
	const s = useIDE();
	const [editing, setEditing] = useState(false);
	const [edited, setEdited] = useState(suggestion.lines.join("\n"));
	const [decided, setDecided] = useState<"adopted" | "ignored" | null>(null);

	const act = async (action: "adopt" | "ignore", editedLines?: string[]) => {
		const r = await s.client!.request("memory.decide", { suggestionId: suggestion.suggestionId, action, editedLines });
		if (r.ok) setDecided(action === "adopt" ? "adopted" : "ignored");
	};

	if (decided) {
		return (
			<div className="self-start rounded-lg border px-3 py-2 text-xs" style={{ background: "var(--bg2)", borderColor: decided === "adopted" ? "var(--green)" : "var(--line)", color: "var(--fg-dim)" }}>
				{decided === "adopted" ? "✓ 已采纳并写入 " + suggestion.file : "已忽略(可在记忆面板手动补录)"}
			</div>
		);
	}

	return (
		<div className="self-start w-min-[880px] rounded-xl border p-3" style={{ background: "linear-gradient(180deg,rgba(196,181,253,.08),var(--bg2))", borderColor: "#4b4370", maxWidth: "100%" }}>
			<div className="mb-2 flex items-center gap-2 text-xs font-medium" style={{ color: "var(--purple)" }}>
				✦ 记忆建议({suggestion.reason})
			</div>
			<div className="mb-2 rounded-lg border p-2 font-mono text-[11.5px] leading-relaxed" style={{ background: "var(--bg0)", borderColor: "var(--line)", color: "var(--fg-dim)" }}>
				<div style={{ color: "var(--purple)" }}>{suggestion.file}</div>
				{editing ? (
					<textarea value={edited} onChange={(e) => setEdited(e.target.value)} className="mt-1 h-20 w-full resize-none bg-transparent outline-none" style={{ color: "var(--fg)" }} />
				) : (
					suggestion.lines.map((l, i) => <div key={i}>- {l}</div>)
				)}
			</div>
			{editing ? (
				<div className="flex gap-2">
					<button onClick={() => void act("adopt", edited.split("\n").map((x) => x.replace(/^- /, "").trim()).filter(Boolean))} className="rounded border px-3 py-1 text-xs" style={{ background: "var(--purple)", borderColor: "var(--purple)", color: "#171226", fontWeight: 600 }}>
						改后采纳
					</button>
					<button onClick={() => setEditing(false)} className="rounded border px-3 py-1 text-xs" style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}>
						取消编辑
					</button>
				</div>
			) : (
				<div className="flex gap-2">
					<button onClick={() => void act("adopt")} className="rounded border px-3 py-1 text-xs" style={{ background: "var(--purple)", borderColor: "var(--purple)", color: "#171226", fontWeight: 600 }}>
						采纳并写入
					</button>
					<button onClick={() => setEditing(true)} className="rounded border px-3 py-1 text-xs" style={{ borderColor: "var(--line2)", color: "var(--fg)" }}>
						改后采纳
					</button>
					<button onClick={() => void act("ignore")} className="rounded border px-3 py-1 text-xs" style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}>
						忽略
					</button>
				</div>
			)}
		</div>
	);
}
