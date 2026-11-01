/** 右侧工作流停靠:计划 | 评审队列(W6 人工门禁)独立面板,各自展开/收起 + 最右窄菜单 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";
import { PlanDockInner } from "./PlanDock";

interface ReviewItemView {
	id: string;
	kind: "commit" | "memory" | "checks";
	title: string;
	detail: string;
	branch?: string;
	state: "pending" | "approved" | "asked" | "ignored";
}

export function WorkflowDock() {
	// 两个面板独立开关:窄条按钮或标题行 × 均可 toggle,互不挤占
	const [open, setOpen] = useState<{ plan: boolean; review: boolean }>({ plan: true, review: false });
	const s = useIDE();
	const pending = s.reviewPending;
	const toggle = (k: "plan" | "review") => setOpen((o) => ({ ...o, [k]: !o[k] }));
	const anyOpen = open.plan || open.review;

	return (
		<div className="flex" style={{ flex: "0 0 auto" }}>
			{anyOpen && (
				<aside className="flex w-[290px] min-w-0 flex-col" style={{ background: "var(--bg1)", borderLeft: "1px solid var(--line)" }}>
					{open.plan && (
						<section
							className="flex min-h-0 flex-1 flex-col"
							style={{ borderBottom: open.review ? "1px solid var(--line)" : undefined }}
						>
							<PlanDockInner onClose={() => toggle("plan")} />
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
