/**
 * 任务卡看板(P3.3):任务→Worker→验证→人收 的聚合视图(HiFox 语义本地化)。
 * 数据源 = tasks.list(编排任务卡)+ orchestrator.workers(Worker 实时态,3s 轮询)
 * + races(竞赛得分,经 race.updated 事件刷新)。兼 P2 的 Worker 面板。
 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";
import type { OrchestrationTask, WorkerRecordView } from "@jide/contracts";
import { Icon } from "./Icon";

const W_STATUS_LABEL: Record<string, string> = {
	queued: "排队",
	running: "运行中",
	done: "完成",
	failed: "失败",
	timeout: "超时",
	aborted: "已中断",
};
const W_STATUS_COLOR: Record<string, string> = {
	queued: "var(--fg-faint)",
	running: "var(--acc)",
	done: "var(--green)",
	failed: "var(--red)",
	timeout: "var(--yellow)",
	aborted: "var(--fg-faint)",
};
const SOURCE_LABEL: Record<OrchestrationTask["source"], string> = {
	chat: "聊天委派",
	automation: "自动化",
	race: "竞赛",
	manual: "手动",
};
const SOURCE_STYLE: Record<OrchestrationTask["source"], { bg: string; fg: string }> = {
	chat: { bg: "var(--acc-bg, rgba(59,130,246,.12))", fg: "var(--acc)" },
	automation: { bg: "var(--green-bg)", fg: "var(--green)" },
	race: { bg: "var(--purple-bg)", fg: "var(--purple)" },
	manual: { bg: "var(--bg3)", fg: "var(--fg-dim)" },
};
const TASK_STATUS_LABEL: Record<string, string> = {
	running: "运行中",
	verifying: "验证中",
	"awaiting-review": "待人工收口",
	done: "已完成",
	failed: "失败",
	cancelled: "已终止",
};

const COLUMNS: Array<{ key: string; label: string; match: (t: OrchestrationTask) => boolean; color: string }> = [
	{ key: "running", label: "运行中", match: (t) => t.status === "running" || t.status === "verifying", color: "var(--acc)" },
	{ key: "review", label: "待收口", match: (t) => t.status === "awaiting-review", color: "var(--yellow)" },
	{ key: "done", label: "已完成", match: (t) => t.status === "done", color: "var(--green)" },
	{ key: "dead", label: "失败 · 终止", match: (t) => t.status === "failed" || t.status === "cancelled", color: "var(--red)" },
];

function TaskCard({ task, workers, onClose }: { task: OrchestrationTask; workers: Map<string, WorkerRecordView>; onClose: (id: string) => void }) {
	const s = useIDE();
	const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	const race = task.raceId ? s.races.find((r) => r.id === task.raceId) : undefined;
	const src = SOURCE_STYLE[task.source];
	return (
		<div
			className="rounded-lg border p-2.5"
			style={{
				background: "var(--bg2)",
				borderColor: task.status === "awaiting-review" ? "var(--yellow)" : "var(--line)",
			}}
		>
			<div className="flex items-center gap-1.5">
				<span className="rounded px-1 text-[9.5px]" style={{ background: src.bg, color: src.fg }}>
					{SOURCE_LABEL[task.source]}
				</span>
				<span className="truncate text-[12.5px] font-medium" title={task.objective}>
					{task.title}
				</span>
				{terminal && (
					<button
						title="清理卡片"
						className="ml-auto flex h-4 w-4 flex-none items-center justify-center rounded hover:bg-[var(--bg3)]"
						style={{ color: "var(--fg-faint)" }}
						onClick={() => onClose(task.id)}
					>
						<Icon name="ri-close-line" size={12} />
					</button>
				)}
			</div>
			<div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>
				{TASK_STATUS_LABEL[task.status]}
				{task.workerIds.length > 0 ? ` · Worker ×${task.workerIds.length}` : ""}
				{" · "}
				{new Date(task.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
			</div>
			{task.summary && (
				<div className="mt-1 line-clamp-3 text-[11px] leading-snug" style={{ color: "var(--fg-dim)" }} title={task.summary}>
					{task.summary}
				</div>
			)}
			{race && race.status !== "running" && (
				<div className="mt-1 text-[10.5px]" style={{ color: "var(--purple)" }}>
					{race.status === "awaiting-review"
						? "竞赛收束,待人工选优"
						: race.status === "resolved"
							? `已选优:${race.winnerEntryId ?? ""}${typeof race.entries.find((e) => e.workerId === race.winnerEntryId)?.score === "number" ? ` · ${race.entries.find((e) => e.workerId === race.winnerEntryId)!.score} 分` : ""}`
							: `竞赛 ${race.status}`}
				</div>
			)}
			{task.workerIds.length > 0 && (
				<div className="mt-1.5 flex flex-col gap-0.5">
					{task.workerIds.map((wid) => {
						const w = workers.get(wid);
						const st = w?.status ?? "?";
						return (
							<div key={wid} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10.5px]" style={{ background: "var(--bg3)" }}>
								<span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: W_STATUS_COLOR[st] ?? "var(--fg-faint)" }} />
								<span className="font-mono" style={{ color: "var(--fg-faint)" }}>{wid}</span>
								<span style={{ color: W_STATUS_COLOR[st] ?? "var(--fg-dim)" }}>{W_STATUS_LABEL[st] ?? st}</span>
								{w?.verified === "green" && <span className="rounded px-1 text-[9px]" style={{ background: "var(--green-bg)", color: "var(--green)" }}>验证绿</span>}
								{w?.verified === "red" && <span className="rounded px-1 text-[9px]" style={{ background: "rgba(239,68,68,.12)", color: "var(--red)" }}>验证红</span>}
								{typeof w?.durationMs === "number" && (
									<span className="ml-auto font-mono" style={{ color: "var(--fg-faint)" }}>{Math.round(w.durationMs / 1000)}s</span>
								)}
							</div>
						);
					})}
				</div>
			)}
			{task.status === "awaiting-review" && (
				<div className="mt-1 text-[10.5px]" style={{ color: "var(--yellow)" }}>
					{race ? "在竞赛面板选优" : "在评审队列人工收口"} →
				</div>
			)}
		</div>
	);
}

export function KanbanBoard() {
	const s = useIDE();
	const [workers, setWorkers] = useState<Map<string, WorkerRecordView>>(new Map());

	useEffect(() => {
		void s.refreshTasks();
		const pull = async () => {
			if (!s.client) return;
			const r = await s.client.request("orchestrator.workers", {});
			if (r.ok) setWorkers(new Map(r.workers.map((w) => [w.id, w])));
		};
		void pull();
		const timer = setInterval(() => void pull(), 3000);
		return () => clearInterval(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const openCount = s.tasks.filter((t) => t.status === "running" || t.status === "verifying" || t.status === "awaiting-review").length;

	return (
		<div className="flex h-full flex-col" style={{ background: "var(--bg0)" }}>
			<div className="flex flex-none items-center gap-2 px-4 py-2" style={{ borderBottom: "1px solid var(--line)" }}>
				<Icon name="ri-kanban-view-2" size={14} color="var(--acc)" />
				<span className="text-xs font-semibold" style={{ letterSpacing: 1 }}>任务看板</span>
				<span className="text-[10.5px]" style={{ color: "var(--fg-faint)" }}>
					任务 → Worker → 验证 → 人收(数据源:编排 Worker 池 / 竞赛 / 自动化;daemon 常驻历史保留)
				</span>
				<span className="ml-auto text-[10.5px]" style={{ color: "var(--fg-faint)" }}>
					进行中 {openCount} / 全部 {s.tasks.length}
				</span>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-4 gap-2 overflow-hidden p-2.5">
				{COLUMNS.map((col) => {
					const list = s.tasks.filter(col.match);
					return (
						<div key={col.key} className="flex min-h-0 flex-col rounded-lg" style={{ background: "var(--bg1)" }}>
							<div className="flex flex-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold" style={{ color: col.color }}>
								{col.label}
								<span className="rounded-full px-1.5 text-[10px]" style={{ background: "var(--bg3)", color: "var(--fg-dim)" }}>
									{list.length}
								</span>
							</div>
							<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-1.5">
								{list.map((t) => (
									<TaskCard key={t.id} task={t} workers={workers} onClose={(id) => void s.dismissTask(id)} />
								))}
								{list.length === 0 && (
									<div className="px-2 py-3 text-[10.5px]" style={{ color: "var(--fg-faint)" }}>—</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
