/** 右侧工作流停靠:计划面板(创建/推进;隔离区自动提交 W5) */

import { useState } from "react";
import { useIDE } from "../store";

export function PlanDockInner({ onClose }: { onClose?: () => void }) {
	const s = useIDE();
	const [creating, setCreating] = useState(false);
	const [goal, setGoal] = useState("");
	const [steps, setSteps] = useState("");
	const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
	const isolated = active?.kind === "worktree";
	const done = s.plan ? s.plan.steps.filter((st) => st.state === "done").length : 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col pb-2">
			<div
				className="flex h-[34px] flex-none items-center px-3 text-[11px] font-semibold"
				style={{ letterSpacing: 1.5, color: "var(--fg-dim)" }}
			>
				计划 · 当前 todo {s.plan ? `(${done}/${s.plan.steps.length})` : ""}
				{onClose && (
					<button
						title="收起"
						className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg2)]"
						style={{ color: "var(--fg-faint)" }}
						onClick={onClose}
					>
						×
					</button>
				)}
			</div>
			<div className="flex-1 overflow-y-auto pb-2">
				{!s.plan && !creating && (
					<div className="px-3 py-3 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
						暂无进行中计划。
						<button className="underline" style={{ color: "var(--acc)" }} onClick={() => setCreating(true)}>
							创建计划
						</button>
					</div>
				)}
				{creating && (
					<div className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: "var(--line)" }}>
						<input
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="目标,如:修复购物车总额浮点 bug"
							className="mb-2 w-full rounded border bg-transparent px-2 py-1.5 text-xs outline-none"
							style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
						/>
						<textarea
							value={steps}
							onChange={(e) => setSteps(e.target.value)}
							placeholder={"每行一个步骤:\n定位逻辑\n修改实现\n回归验证"}
							className="mb-2 h-28 w-full resize-none rounded border bg-transparent px-2 py-1.5 text-xs outline-none"
							style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
						/>
						<div className="flex gap-2">
							<button
								className="rounded border px-2.5 py-1 text-xs"
								style={{ background: "var(--acc-dim)", borderColor: "var(--acc-line)", color: "var(--acc-text)" }}
								onClick={async () => {
									const list = steps
										.split("\n")
										.map((x) => x.trim())
										.filter(Boolean);
									if (goal.trim() && list.length) {
										await s.createPlan(goal.trim(), list);
										setCreating(false);
										setGoal("");
										setSteps("");
									}
								}}
							>
								创建
							</button>
							<button className="rounded border px-2.5 py-1 text-xs" style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }} onClick={() => setCreating(false)}>
								取消
							</button>
						</div>
					</div>
				)}
				{s.plan && (
					<div className="mx-2.5 my-2 rounded-lg border p-2.5" style={{ background: "var(--bg2)", borderColor: "var(--line)" }}>
						<div className="mb-0.5 text-[12.5px] font-medium">{s.plan.goal}</div>
						<div className="mb-2 text-[11px]" style={{ color: "var(--fg-faint)" }}>
							{isolated ? "隔离工作区 · 步骤完成自动提交" : "Default 工作区 · 自动提交已禁用"}
						</div>
						{s.plan.steps.map((st, i) => (
							<div key={i} className="flex items-start gap-2 py-1">
								<button
									className="mt-[2px] flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border"
									style={{
										borderColor: st.state === "done" ? "var(--green)" : st.state === "doing" ? "var(--acc)" : "var(--fg-faint)",
										background: st.state === "done" ? "var(--green)" : undefined,
									}}
									title="标记完成"
									onClick={() => st.state !== "done" && void s.planStepDone(i)}
								/>
								<div className="min-w-0 flex-1">
									<div
										className="text-[12px] leading-snug"
										style={{
											color: st.state === "done" ? "var(--fg-faint)" : st.state === "doing" ? "var(--fg)" : "var(--fg-dim)",
											textDecoration: st.state === "done" ? "line-through" : undefined,
										}}
									>
										{st.text}
									</div>
									{st.commit && (
										<div className="font-mono text-[10px]" style={{ color: "var(--green)" }}>{st.commit}</div>
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
			<div
				className="flex items-center gap-1.5 px-3 py-1.5 text-[11px]"
				style={{ borderTop: "1px solid var(--line)", color: "var(--fg-faint)" }}
			>
				计划步骤自动提交{isolated ? " · 已开启(仅隔离工作区)" : " · 未启用(当前为 Default)"}
			</div>
		</div>
	);
}
