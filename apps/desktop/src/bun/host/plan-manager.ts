/**
 * PlanManager — 计划与步骤自动提交(business-design §3 W5 / §6)
 *
 *  - 计划 = 当前工作区的步骤清单(一个进行中)
 *  - stepDone 在隔离工作区 → commitAll("Agent · 计划步骤 N:<描述>")
 *  - 事件 plan.updated 推给右侧工作流面板
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmitFn } from "./agent-host";
import type { WorkspaceManager } from "./workspace-manager";

export interface PlanStep {
	text: string;
	state: "pending" | "doing" | "done";
	commit?: string;
}

export interface Plan {
	id: string;
	workspaceId: string;
	goal: string;
	steps: PlanStep[];
}

export class PlanManager {
	private plans = new Map<string, Plan>();
	private nextId = 1;
	private emit: EmitFn = () => {};
	private storePath: string;

	constructor(private workspaces: WorkspaceManager, runtimeRoot: string, private review?: { enqueueCommit: (workspaceId: string, branch: string, sha: string, message: string) => void }) {
		mkdirSync(runtimeRoot, { recursive: true });
		this.storePath = join(runtimeRoot, "plans.json");
		if (existsSync(this.storePath)) {
			try {
				const data = JSON.parse(readFileSync(this.storePath, "utf8")) as Plan[];
				for (const p of data) {
					this.plans.set(p.id, p);
					const n = Number(p.id.replace("plan-", ""));
					if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
				}
			} catch {
				/* 损坏则从空开始 */
			}
		}
	}

	private persist() {
		writeFileSync(this.storePath, JSON.stringify([...this.plans.values()], null, "\t"));
	}

	/** W5→W6 联动:步骤自动提交入评审队列(人工门禁) */
	setReviewQueue(review: { enqueueCommit: (workspaceId: string, branch: string, sha: string, message: string) => void }) {
		this.review = review;
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	getByWorkspace(workspaceId: string): Plan | undefined {
		for (const p of this.plans.values()) if (p.workspaceId === workspaceId) return p;
		return undefined;
	}

	create(workspaceId: string, goal: string, steps: string[]) {
		// 一个工作区一个进行中计划:旧的归档(删除)
		const old = this.getByWorkspace(workspaceId);
		if (old) this.plans.delete(old.id);
		const plan: Plan = {
			id: `plan-${this.nextId++}`,
			workspaceId,
			goal,
			steps: steps.map((text, i) => ({
				text,
				state: i === 0 ? "doing" : "pending",
			})),
		};
		this.plans.set(plan.id, plan);
		this.persist();
		this.pushPlan(plan);
		return plan;
	}

	/** W5:步骤完成 → (隔离区)自动提交 */
	async stepDone(planId: string, stepIndex: number) {
		const plan = this.plans.get(planId);
		if (!plan) return { ok: false as const, error: `计划不存在:${planId}` };
		const step = plan.steps[stepIndex];
		if (!step) return { ok: false as const, error: `步骤越界:${stepIndex}` };

		const ws = this.workspaces.locate(plan.workspaceId);
		const info = ws.projectId
			? this.workspaces.getWorkspace(ws.projectId, plan.workspaceId)
			: undefined;

		step.state = "done";
		let commit: { sha: string; message: string } | undefined;
		if (info?.kind === "worktree") {
			const msg = `Agent · 计划步骤 ${stepIndex + 1}:${step.text}`;
			const r = await this.workspaces.commitAll(plan.workspaceId, msg, true);
			if (r.ok) {
				commit = { sha: r.sha, message: msg };
				step.commit = r.sha;
				// W5→W6:自动提交进入评审队列(人工门禁)
				this.review?.enqueueCommit(plan.workspaceId, info.branch, r.sha, msg);
			} else if (r.error !== "nothing to commit") {
				// 提交失败步骤仍完成,但记录问题
				this.emit({
					type: "host.log",
					level: "warn",
					message: `步骤 ${stepIndex + 1} 自动提交失败:${r.error}`,
				});
			}
		}
		// 下一步置 doing
		const next = plan.steps[stepIndex + 1];
		if (next && next.state === "pending") next.state = "doing";

		this.persist();
		this.pushPlan(plan);
		return { ok: true as const, commit };
	}

	private pushPlan(plan: Plan) {
		this.emit({
			type: "plan.updated",
			planId: plan.id,
			workspaceId: plan.workspaceId,
			goal: plan.goal,
			steps: plan.steps,
		});
	}
}
