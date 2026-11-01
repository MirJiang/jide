/** 右侧工作流停靠:计划 | 评审队列(W6 人工门禁)| 自动化(P1.5)独立面板,各自展开/收起 + 最右窄菜单 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";
import type { Automation, AutomationRun } from "@jide/contracts";
import { PlanDockInner } from "./PlanDock";
import { Icon } from "./Icon";

interface ReviewItemView {
	id: string;
	kind: "commit" | "memory" | "checks";
	title: string;
	detail: string;
	branch?: string;
	state: "pending" | "approved" | "asked" | "ignored";
}

export function WorkflowDock() {
	// 四个面板独立开关:窄条按钮或标题行 × 均可 toggle,互不挤占
	const [open, setOpen] = useState<{ plan: boolean; review: boolean; auto: boolean; race: boolean }>({
		plan: true,
		review: false,
		auto: false,
		race: false,
	});
	const s = useIDE();
	const pending = s.reviewPending;
	const toggle = (k: "plan" | "review" | "auto" | "race") => setOpen((o) => ({ ...o, [k]: !o[k] }));
	const anyOpen = open.plan || open.review || open.auto || open.race;
	const racesAwaiting = s.races.filter((r) => r.status === "awaiting-review").length;

	return (
		<div className="flex" style={{ flex: "0 0 auto" }}>
			{anyOpen && (
				<aside className="flex w-[290px] min-w-0 flex-col" style={{ background: "var(--bg1)", borderLeft: "1px solid var(--line)" }}>
					{open.plan && (
						<section
							className="flex min-h-0 flex-1 flex-col"
							style={{ borderBottom: open.review || open.auto || open.race ? "1px solid var(--line)" : undefined }}
						>
							<PlanDockInner onClose={() => toggle("plan")} />
						</section>
					)}
					{open.race && (
						<section
							className="flex min-h-0 flex-1 flex-col"
							style={{ borderBottom: open.review || open.auto ? "1px solid var(--line)" : undefined }}
						>
							<RacesPanel onClose={() => toggle("race")} />
						</section>
					)}
					{open.auto && (
						<section
							className="flex min-h-0 flex-1 flex-col"
							style={{ borderBottom: open.review ? "1px solid var(--line)" : undefined }}
						>
							<AutomationPanel onClose={() => toggle("auto")} />
						</section>
					)}
					{open.review && (
						<section className="flex min-h-0 flex-1 flex-col">
							<div
								className="flex h-[34px] flex-none items-center gap-1 px-3 text-[11px] font-semibold"
								style={{ letterSpacing: 1.5, color: "var(--fg-dim)" }}
							>
								评审队列{pending > 0 ? `(${pending})` : ""}
								<button
									title="收起"
									className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
									style={{ color: "var(--fg-faint)" }}
									onClick={() => toggle("review")}
								>
									×
								</button>
							</div>
							<div className="min-h-0 flex-1 overflow-y-auto">
								<ReviewPanel />
							</div>
						</section>
					)}
				</aside>
			)}
			{/* 最右窄菜单(原型 rail2):点谁展开谁,再点收起 */}
			<nav className="flex w-[46px] flex-col items-center gap-1 pt-1.5" style={{ background: "var(--bg1)", borderLeft: "1px solid var(--line)" }}>
				<button
					title="计划 · 当前 todo"
					className="relative flex h-[38px] w-[38px] items-center justify-center rounded-lg text-lg"
					style={{ color: open.plan ? "var(--acc)" : "var(--fg-faint)", background: open.plan ? "var(--bg2)" : undefined }}
					onClick={() => toggle("plan")}
				>
					☑
				</button>
				<button
					title="竞赛 · 一拖 N 对比选优"
					className="relative flex h-[38px] w-[38px] items-center justify-center rounded-lg"
					style={{ color: open.race ? "var(--acc)" : "var(--fg-faint)", background: open.race ? "var(--bg2)" : undefined }}
					onClick={() => toggle("race")}
				>
					<Icon name="ri-trophy-line" size={19} />
					{racesAwaiting > 0 && (
						<span className="absolute right-0.5 top-0.5 rounded-full px-1 text-[9px] font-bold" style={{ background: "var(--acc)", color: "var(--bg0)" }}>
							{racesAwaiting}
						</span>
					)}
				</button>
				<button
					title="自动化 · 定时/事件任务"
					className="relative flex h-[38px] w-[38px] items-center justify-center rounded-lg"
					style={{ color: open.auto ? "var(--acc)" : "var(--fg-faint)", background: open.auto ? "var(--bg2)" : undefined }}
					onClick={() => toggle("auto")}
				>
					<Icon name="ri-timer-flash-line" size={19} />
					{s.automations.filter((a) => a.enabled).length > 0 && (
						<span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full" style={{ background: "var(--acc)" }} />
					)}
				</button>
				<button
					title="评审队列"
					className="relative flex h-[38px] w-[38px] items-center justify-center rounded-lg text-lg"
					style={{ color: open.review ? "var(--acc)" : "var(--fg-faint)", background: open.review ? "var(--bg2)" : undefined }}
					onClick={() => toggle("review")}
				>
					✓
					{pending > 0 && (
						<span className="absolute right-0.5 top-0.5 rounded-full px-1 text-[9px] font-bold" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
							{pending}
						</span>
					)}
				</button>
			</nav>
		</div>
	);
}

/* ---------------- 自动化面板(P1.5):列表/启停/立即跑/编辑/历史 ---------------- */

const triggerDesc = (t: Automation["trigger"]): string =>
	t.kind === "cron"
		? `cron ${t.expr}`
		: t.kind === "daily"
			? `每日 ${t.time}`
			: t.kind === "weekdays"
				? `工作日 ${t.time}`
				: `事件 · ${t.type === "test-failed" ? "测试失败" : "检查项失败"}`;

const runStatusLabel: Record<AutomationRun["status"], string> = {
	queued: "排队",
	running: "运行中",
	ok: "完成",
	failed: "失败",
	timeout: "超时",
};
const runStatusColor: Record<AutomationRun["status"], string> = {
	queued: "var(--fg-faint)",
	running: "var(--acc)",
	ok: "var(--green)",
	failed: "var(--red)",
	timeout: "var(--yellow)",
};

function blankAutomation(projectId: string | null, workspaceId: string | null): Automation {
	return {
		id: "",
		name: "",
		enabled: true,
		trigger: { kind: "daily", time: "22:00" },
		prompt: "",
		modelKey: "",
		target: projectId ? { kind: "repo", repoId: projectId } : { kind: "workspace", workspaceId: workspaceId ?? "" },
		reuseSession: false,
		autoVerify: true,
		timeoutMin: 30,
		createdAt: 0,
	};
}

/* ---------------- 竞赛面板(P3):开赛 / 对比 / 选优 ---------------- */

function RacesPanel({ onClose }: { onClose: () => void }) {
	const s = useIDE();
	const [creating, setCreating] = useState(false);
	const [objective, setObjective] = useState("");
	const [count, setCount] = useState(3);
	const [models, setModels] = useState<string[]>(["", "", "", ""]);
	const [err, setErr] = useState("");

	useEffect(() => {
		void s.refreshRaces();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const modelOptions: Array<[string, string]> = [["", "pi 默认"], ...s.modelCatalog.map((m) => [m.key, m.name] as [string, string])];
	const field = "w-full rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none focus:border-[var(--acc)]";
	const fieldStyle = { borderColor: "var(--line)", color: "var(--fg)" } as const;

	const start = async () => {
		setErr("");
		const variants = Array.from({ length: count }, (_, i) => ({ modelKey: models[i] || undefined }));
		const e = await s.startRace(objective, variants);
		if (e) setErr(e);
		else {
			setObjective("");
			setCreating(false);
		}
	};

	const scoreColor = (n?: number) => (n === undefined ? "var(--fg-faint)" : n >= 100 ? "var(--green)" : n > 0 ? "var(--yellow)" : "var(--red)");

	return (
		<>
			<div className="flex h-[34px] flex-none items-center gap-1 px-3 text-[11px] font-semibold" style={{ letterSpacing: 1.5, color: "var(--fg-dim)" }}>
				竞赛
				<button
					title="新建竞赛"
					className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
					style={{ color: "var(--acc)" }}
					onClick={() => setCreating((v) => !v)}
				>
					<Icon name="ri-add-line" size={15} />
				</button>
				<button
					title="收起"
					className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-faint)" }}
					onClick={onClose}
				>
					×
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-2">
				{err && (
					<div className="mx-2.5 mb-2 rounded border px-2 py-1 text-[11px]" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
						{err}
					</div>
				)}
				{creating && (
					<div className="mx-2.5 mb-2 flex flex-col gap-1.5 rounded-lg border p-2" style={{ background: "var(--bg2)", borderColor: "var(--acc-line)" }}>
						<textarea rows={3} className={field} style={fieldStyle} placeholder="竞赛任务书(自包含:做什么/验收标准/边界)" value={objective} onChange={(e) => setObjective(e.target.value)} />
						<div className="flex items-center gap-1.5">
							<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>路数</span>
							<select className={field} style={{ ...fieldStyle, width: 56 }} value={count} onChange={(e) => setCount(Number(e.target.value))}>
								{[2, 3, 4].map((n) => (
									<option key={n} value={n}>{n}</option>
								))}
							</select>
						</div>
						{Array.from({ length: count }, (_, i) => (
							<div key={i} className="flex items-center gap-1.5">
								<span className="w-8 text-[11px]" style={{ color: "var(--fg-faint)" }}>路{i + 1}</span>
								<select className={field} style={fieldStyle} value={models[i] ?? ""} onChange={(e) => setModels((m) => m.map((x, j) => (j === i ? e.target.value : x)))}>
									{modelOptions.map(([v, lbl]) => (
										<option key={v} value={v}>{lbl}</option>
									))}
								</select>
							</div>
						))}
						<button className="jide-btn px-3 py-1 text-xs" disabled={!objective.trim()} onClick={() => void start()}>
							<Icon name="ri-flag-line" size={13} />
							开赛
						</button>
					</div>
				)}
				{s.races.length === 0 && (
					<div className="px-3 py-2 text-[11.5px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
						还没有竞赛。开一场:同一任务书在 N 个隔离 worktree 并行执行,收束后自动评分,你人工选优合入主线(也可在对话里让 agent 用 start_race 开赛)。
					</div>
				)}
				{s.races.map((race) => (
					<div key={race.id} className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: race.status === "awaiting-review" ? "var(--acc-line)" : "var(--line)" }}>
						<div className="flex items-center gap-1.5">
							<Icon
								name={race.status === "resolved" && race.resolution === "merged" ? "ri-trophy-fill" : "ri-flag-line"}
								size={13}
								color={race.status === "awaiting-review" ? "var(--acc)" : "var(--fg-faint)"}
							/>
							<span className="truncate text-[12px] font-medium">{race.objective.slice(0, 40)}</span>
							<span className="ml-auto flex-none text-[10px]" style={{ color: race.status === "awaiting-review" ? "var(--acc)" : "var(--fg-faint)" }}>
								{race.status === "running" ? "进行中" : race.status === "awaiting-review" ? "待选优" : race.status === "cancelled" ? "已取消" : race.resolution === "merged" ? "已合入" : "已丢弃"}
							</span>
						</div>
						<div className="mt-1.5 flex flex-col gap-1">
							{race.entries.map((e) => (
								<div key={e.workerId} className="rounded px-1.5 py-1" style={{ background: "var(--bg3)" }}>
									<div className="flex items-center gap-1.5 text-[11px]">
										<span className="font-mono" style={{ color: "var(--fg-faint)" }}>{e.workerId}</span>
										{e.score !== undefined && (
											<span className="rounded px-1 text-[10px] font-bold" style={{ background: "var(--bg1)", color: scoreColor(e.score) }}>
												{e.score} 分
											</span>
										)}
										<span className="ml-auto text-[10px]" style={{ color: "var(--fg-faint)" }}>
											{e.status === "running" ? "运行中" : e.status === "queued" ? "排队" : e.status === "done" ? `${e.changedFiles?.length ?? 0} 文件变更` : e.status}
										</span>
									</div>
									{e.summary && (
										<div className="mt-0.5 text-[10.5px] leading-snug" style={{ color: "var(--fg-dim)" }}>
											{e.summary.slice(0, 100)}
										</div>
									)}
									{e.error && (
										<div className="mt-0.5 text-[10.5px]" style={{ color: "var(--red)" }}>
											{e.error.slice(0, 80)}
										</div>
									)}
									{race.status === "awaiting-review" && e.sha && (
										<button
											className="mt-1 flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-[var(--bg2)]"
											style={{ borderColor: "var(--green)", color: "var(--green)" }}
											onClick={() => void s.resolveRace(race.id, e.workerId)}
										>
											<Icon name="ri-trophy-line" size={12} />
											选为最优并合入
										</button>
									)}
								</div>
							))}
						</div>
						<div className="mt-1.5 flex gap-1.5">
							{race.status === "running" && (
								<button
									className="rounded border px-2 py-0.5 text-[11px] hover:bg-[var(--bg2)]"
									style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
									onClick={() => void s.cancelRace(race.id)}
								>
									取消
								</button>
							)}
							{(race.status === "awaiting-review" || race.status === "running") && (
								<button
									className="rounded border px-2 py-0.5 text-[11px] hover:bg-[var(--bg2)]"
									style={{ borderColor: "var(--line)", color: "var(--fg-faint)" }}
									onClick={() => void s.discardRace(race.id)}
								>
									全部丢弃
								</button>
							)}
							{race.status === "resolved" && race.note && (
								<span className="text-[10.5px]" style={{ color: "var(--fg-faint)" }}>
									{race.note}
								</span>
							)}
						</div>
					</div>
				))}
			</div>
		</>
	);
}

function AutomationPanel({ onClose }: { onClose: () => void }) {
	const s = useIDE();
	const [editing, setEditing] = useState<Automation | null>(null);
	const [err, setErr] = useState("");
	const [showHistory, setShowHistory] = useState<string | null>(null);

	useEffect(() => {
		void s.refreshAutomations();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const save = async (a: Automation) => {
		setErr("");
		const e = await s.saveAutomation(a);
		if (e) setErr(e);
		else setEditing(null);
	};

	return (
		<>
			<div className="flex h-[34px] flex-none items-center gap-1 px-3 text-[11px] font-semibold" style={{ letterSpacing: 1.5, color: "var(--fg-dim)" }}>
				自动化
				<button
					title="新建任务"
					className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
					style={{ color: "var(--acc)" }}
					onClick={() => setEditing(blankAutomation(s.project?.id ?? null, s.activeWorkspaceId))}
				>
					<Icon name="ri-add-line" size={15} />
				</button>
				<button
					title="收起"
					className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-faint)" }}
					onClick={onClose}
				>
					×
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-2">
				{err && (
					<div className="mx-2.5 mb-2 rounded border px-2 py-1 text-[11px]" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
						{err}
					</div>
				)}
				{editing ? (
					<AutomationEditor
						draft={editing}
						onChange={setEditing}
						onCancel={() => setEditing(null)}
						onSave={() => void save(editing)}
					/>
				) : (
					<>
						{s.automations.length === 0 && (
							<div className="px-3 py-2 text-[11.5px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
								还没有自动化任务。新建一条:定时(每日/cron)或事件(测试失败)触发 → agent 在隔离工作区干活 → 自动验证 → 评审队列收口。daemon 常驻,关 app 照跑。
							</div>
						)}
						{s.automations.map((a) => {
							const runs = s.automationRuns[a.id] ?? [];
							const latest = runs[0];
							return (
								<div key={a.id} className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: "var(--line)", opacity: a.enabled ? 1 : 0.6 }}>
									<div className="flex items-center gap-1.5">
										<span className="truncate text-[12.5px] font-medium">{a.name || "(未命名)"}</span>
										<button
											title={a.enabled ? "停用" : "启用"}
											className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg3)]"
											style={{ color: a.enabled ? "var(--green)" : "var(--fg-faint)" }}
											onClick={() => void s.saveAutomation({ ...a, enabled: !a.enabled })}
										>
											<Icon name={a.enabled ? "ri-toggle-right-fill" : "ri-toggle-left-line"} size={16} />
										</button>
										<button
											title="立即运行"
											className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg3)]"
											style={{ color: "var(--acc)" }}
											onClick={() => void s.runAutomation(a.id)}
										>
											<Icon name="ri-play-line" size={14} />
										</button>
										<button
											title="编辑"
											className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg3)]"
											style={{ color: "var(--fg-dim)" }}
											onClick={() => setEditing({ ...a })}
										>
											<Icon name="ri-pencil-line" size={13} />
										</button>
										<button
											title="删除"
											className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg3)]"
											style={{ color: "var(--fg-faint)" }}
											onClick={() => void s.deleteAutomation(a.id)}
										>
											<Icon name="ri-delete-bin-line" size={13} />
										</button>
									</div>
									<div className="mt-0.5 font-mono text-[10.5px]" style={{ color: "var(--fg-faint)" }}>
										{triggerDesc(a.trigger)}
										{a.target.kind === "repo" ? " · 每 run 新 worktree" : " · 指定工作区"}
										{a.reuseSession ? " · 复用会话" : ""}
										{a.autoVerify ? " · 自动验证" : ""}
									</div>
									{latest && (
										<div className="mt-1 text-[11px]" style={{ color: runStatusColor[latest.status] }}>
											{runStatusLabel[latest.status]}
											{latest.durationMs !== undefined ? ` · ${Math.round(latest.durationMs / 1000)}s` : ""}
											{latest.tests ? ` · 测试 ${latest.tests.passed}/${latest.tests.passed + latest.tests.failed}` : ""}
											{latest.checks ? ` · 检查项 ${latest.checks.passed}/${latest.checks.total}` : ""}
											{latest.error ? ` · ${latest.error.slice(0, 60)}` : ""}
											<button
												className="ml-1 underline"
												style={{ color: "var(--fg-faint)" }}
												onClick={() => setShowHistory(showHistory === a.id ? null : a.id)}
											>
												历史{runs.length}
											</button>
										</div>
									)}
									{showHistory === a.id && (
										<div className="mt-1 flex flex-col gap-1">
											{runs.slice(0, 5).map((r) => (
												<div key={r.id} className="rounded px-1.5 py-1 text-[10.5px]" style={{ background: "var(--bg3)", color: "var(--fg-dim)" }}>
													<span style={{ color: runStatusColor[r.status] }}>{runStatusLabel[r.status]}</span>
													{" · "}
													{new Date(r.startedAt).toLocaleTimeString()}
													{r.trigger !== "manual" ? ` · ${r.trigger === "schedule" ? "定时" : "事件"}` : " · 手动"}
													{r.summary ? ` · ${r.summary.slice(0, 40)}` : r.error ? ` · ${r.error.slice(0, 40)}` : ""}
												</div>
											))}
										</div>
									)}
								</div>
							);
						})}
					</>
				)}
			</div>
		</>
	);
}

function AutomationEditor({
	draft,
	onChange,
	onCancel,
	onSave,
}: {
	draft: Automation;
	onChange: (a: Automation) => void;
	onCancel: () => void;
	onSave: () => void;
}) {
	const s = useIDE();
	const field = "w-full rounded border bg-transparent px-2 py-1 text-[11.5px] outline-none focus:border-[var(--acc)]";
	const fieldStyle = { borderColor: "var(--line)", color: "var(--fg)" } as const;
	const label = "mb-0.5 block text-[10.5px] font-semibold tracking-wider";
	const labelStyle = { color: "var(--fg-faint)" } as const;
	const modelOptions = [["", "pi 默认"] as [string, string], ...s.modelCatalog.map((m) => [m.key, `${m.name}`] as [string, string])];

	return (
		<div className="flex flex-col gap-2 px-2.5 py-2">
			<div>
				<span className={label} style={labelStyle}>名称</span>
				<input className={field} style={fieldStyle} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
			</div>
			<div>
				<span className={label} style={labelStyle}>任务描述(发给 agent)</span>
				<textarea rows={3} className={field} style={fieldStyle} value={draft.prompt} onChange={(e) => onChange({ ...draft, prompt: e.target.value })} />
			</div>
			<div className="flex gap-2">
				<div className="min-w-0 flex-1">
					<span className={label} style={labelStyle}>触发器</span>
					<select
						className={field}
						style={fieldStyle}
						value={draft.trigger.kind}
						onChange={(e) => {
							const k = e.target.value;
							onChange({
								...draft,
								trigger:
									k === "cron"
										? { kind: "cron", expr: "0 22 * * *" }
										: k === "daily"
											? { kind: "daily", time: "22:00" }
											: k === "weekdays"
												? { kind: "weekdays", time: "09:30" }
												: { kind: "event", type: "test-failed" },
							});
						}}
					>
						<option value="daily">每日</option>
						<option value="weekdays">工作日</option>
						<option value="cron">cron 表达式</option>
						<option value="event">事件触发</option>
					</select>
				</div>
				<div className="min-w-0 flex-1">
					<span className={label} style={labelStyle}>{draft.trigger.kind === "event" ? "事件类型" : draft.trigger.kind === "cron" ? "表达式" : "时间"}</span>
					{draft.trigger.kind === "cron" ? (
						<input className={field} style={fieldStyle} value={draft.trigger.expr} onChange={(e) => onChange({ ...draft, trigger: { kind: "cron", expr: e.target.value } })} />
					) : draft.trigger.kind === "event" ? (
						<select className={field} style={fieldStyle} value={draft.trigger.type} onChange={(e) => onChange({ ...draft, trigger: { kind: "event", type: e.target.value as "test-failed" | "checks-failed" } })}>
							<option value="test-failed">测试失败</option>
							<option value="checks-failed">检查项失败</option>
						</select>
					) : (
						<input type="time" className={field} style={fieldStyle} value={draft.trigger.time} onChange={(e) => onChange({ ...draft, trigger: { ...draft.trigger, time: e.target.value } as any })} />
					)}
				</div>
			</div>
			<div>
				<span className={label} style={labelStyle}>目标</span>
				<select
					className={field}
					style={fieldStyle}
					value={draft.target.kind === "repo" ? `repo:${draft.target.repoId}` : `ws:${draft.target.workspaceId}`}
					onChange={(e) => {
						const v = e.target.value;
						onChange({
							...draft,
							target: v.startsWith("repo:")
								? { kind: "repo", repoId: v.slice(5) }
								: { kind: "workspace", workspaceId: v.slice(3) },
						});
					}}
				>
					{s.project && <option value={`repo:${s.project.id}`}>当前项目 · 每 run 新隔离 worktree</option>}
					{s.workspaces.map((w) => (
						<option key={w.id} value={`ws:${w.id}`}>
							工作区 · {w.branch}
						</option>
					))}
				</select>
			</div>
			<div className="flex gap-2">
				<div className="min-w-0 flex-1">
					<span className={label} style={labelStyle}>模型</span>
					<select className={field} style={fieldStyle} value={draft.modelKey} onChange={(e) => onChange({ ...draft, modelKey: e.target.value })}>
						{modelOptions.map(([v, lbl]) => (
							<option key={v} value={v}>{lbl}</option>
						))}
					</select>
				</div>
				<div style={{ width: 76 }}>
					<span className={label} style={labelStyle}>超时(分)</span>
					<input type="number" min={1} max={720} className={field} style={fieldStyle} value={draft.timeoutMin} onChange={(e) => onChange({ ...draft, timeoutMin: Math.max(1, Number(e.target.value) || 30) })} />
				</div>
			</div>
			<div className="flex gap-4 text-[11.5px]" style={{ color: "var(--fg-dim)" }}>
				<label className="flex cursor-pointer items-center gap-1">
					<input type="checkbox" checked={draft.autoVerify} onChange={(e) => onChange({ ...draft, autoVerify: e.target.checked })} />
					完成后自动验证(测试+检查项→评审队列)
				</label>
			</div>
			<div className="flex gap-4 text-[11.5px]" style={{ color: "var(--fg-dim)" }}>
				<label className="flex cursor-pointer items-center gap-1">
					<input type="checkbox" checked={draft.reuseSession} onChange={(e) => onChange({ ...draft, reuseSession: e.target.checked })} />
					复用会话(连续对话;否则每 run 新会话)
				</label>
			</div>
			<div className="flex gap-1.5">
				<button className="jide-btn px-3 py-1 text-xs" disabled={!draft.name.trim() || !draft.prompt.trim()} onClick={onSave}>
					<Icon name="ri-save-line" size={13} />
					保存
				</button>
				<button className="rounded border px-3 py-1 text-xs hover:bg-[var(--bg2)]" style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }} onClick={onCancel}>
					取消
				</button>
			</div>
		</div>
	);
}

function ReviewPanel() {
	const s = useIDE();
	const [items, setItems] = useState<ReviewItemView[]>([]);
	const [busy, setBusy] = useState<string | null>(null);

	const refresh = async () => {
		if (!s.client || !s.project) return;
		const r = await s.client.request("review.list", { projectId: s.project.id });
		if (r.ok) setItems(r.items as ReviewItemView[]);
	};

	useEffect(() => {
		void refresh();
	}, [s.project?.id, s.reviewPending]);

	const decide = async (id: string, decision: "approve" | "ask" | "ignore") => {
		setBusy(id);
		const r = await s.client!.request("review.decide", { id, decision });
		setBusy(null);
		if (r.ok && "merged" in r && r.merged) {
			useIDE.setState((st) => ({
				logs: [...st.logs, `评审通过 · 已合并进主线(${r.merged!.sha})`],
			}));
			void s.refreshGit();
		}
		if (decision === "ask") {
			const item = items.find((x) => x.id === id);
			await s.askAgent("review", `评审项:${item?.title}(${item?.detail})`, "关于这个评审项,我有个问题:");
		}
		void refresh();
	};

	const kindLabel: Record<string, string> = { commit: "自动提交", memory: "记忆建议", checks: "检查项" };

	return (
		<div className="pb-2">
			<div className="px-3 py-2 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
				自动提交 / 记忆建议 / 检查项经「通过」后方可并入主线(W6 人工门禁)
			</div>
			{items.map((it) => (
				<div key={it.id} className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: "var(--line)", opacity: it.state === "pending" ? 1 : 0.6 }}>
					<div className="mb-0.5 flex items-center gap-1.5 text-[12.5px] font-medium">
						<span
							className="rounded px-1 text-[9.5px]"
							style={
								it.kind === "commit"
									? { background: "var(--purple-bg)", color: "var(--purple)" }
									: it.kind === "memory"
										? { background: "rgba(250,204,21,.12)", color: "var(--yellow)" }
										: { background: "var(--green-bg)", color: "var(--green)" }
							}
						>
							{kindLabel[it.kind]}
						</span>
						<span className="truncate">{it.title}</span>
					</div>
					<div className="mb-2 font-mono text-[10.5px]" style={{ color: "var(--fg-faint)" }}>{it.detail}</div>
					{it.state === "pending" ? (
						<div className="flex gap-1.5">
							{it.kind === "commit" && (
								<button
									disabled={busy === it.id}
									onClick={() => void decide(it.id, "approve")}
									className="rounded border px-2 py-0.5 text-[11.5px] disabled:opacity-40"
									style={{ borderColor: "var(--green)", color: "var(--green)" }}
								>
									通过并合并
								</button>
							)}
							{it.kind !== "commit" && (
								<button
									disabled={busy === it.id}
									onClick={() => void decide(it.id, "approve")}
									className="rounded border px-2 py-0.5 text-[11.5px] disabled:opacity-40"
									style={{ borderColor: "var(--green)", color: "var(--green)" }}
								>
									通过
								</button>
							)}
							<button onClick={() => void decide(it.id, "ask")} className="rounded border px-2 py-0.5 text-[11.5px]" style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}>
								追问
							</button>
							<button onClick={() => void decide(it.id, "ignore")} className="rounded border px-2 py-0.5 text-[11.5px]" style={{ borderColor: "var(--line)", color: "var(--fg-faint)" }}>
								忽略
							</button>
						</div>
					) : (
						<div className="text-[11.5px]" style={{ color: it.state === "approved" ? "var(--green)" : "var(--fg-faint)" }}>
							{it.state === "approved" ? "✓ 已通过" : it.state === "asked" ? "已追问(回聊)" : "已忽略(留档)"}
						</div>
					)}
				</div>
			))}
			{!items.length && <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--fg-faint)" }}>队列空:计划步骤自动提交后会出现在这里。</div>}
		</div>
	);
}
