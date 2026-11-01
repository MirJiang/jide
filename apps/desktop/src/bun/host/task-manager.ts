/**
 * TaskManager — 任务卡看板数据域(P3.3,HiFox 语义本地化:任务→Worker→验证→人收)
 *
 * 聚合既有编排数据成任务卡(不引入团队协作):
 *  - chat:聊天会话经 spawn_worker 委派 → 按 routerSessionId 归组(同轮多 Worker 一张卡,
 *    轮以 agent.settled 收口;Worker 全收束 + 30min 无动静兜底收口)
 *  - automation:automation.run 事件建卡/推进(状态随 run)
 *  - race:races.start 建卡(状态随 race)
 * 持久化 <runtimeRoot>/tasks.json(上限 200 条);重启非终态 → failed(daemon 中断)。
 * 派生状态:running(任一 Worker/源未收束)→ awaiting-review(竞赛待选优)→ done/failed/cancelled。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HostEvent, OrchestrationTask } from "@jide/contracts";
import type { EmitFn } from "./agent-host";

export interface TaskManagerDeps {
	runtimeRoot: string;
	/** automation 卡标题用 */
	getAutomation?(automationId: string): { name: string } | undefined;
	/** race.updated(仅带 raceId)→ 拉全量 race 推进卡片 */
	getRace?(raceId: string): {
		id: string;
		objective: string;
		status: string;
		entries: Array<{ workerId: string; status: string; score?: number; verified?: string; summary?: string }>;
		workspaceId: string;
	} | undefined;
	/** 任务终态回调(P3.4 任务经历写入) */
	onFinalize?(task: OrchestrationTask): void;
	/** 卡片保留上限 */
	maxTasks?: number;
}

const WORKER_TERMINAL = new Set(["done", "failed", "timeout", "aborted"]);
const OPEN_STATUSES = new Set(["running", "verifying"]);

export class TaskManager {
	private tasks = new Map<string, OrchestrationTask>();
	private storePath: string;
	private emit: EmitFn = () => {};
	private readonly deps: TaskManagerDeps;

	constructor(deps: TaskManagerDeps) {
		this.deps = deps;
		this.storePath = join(deps.runtimeRoot, "tasks.json");
		mkdirSync(deps.runtimeRoot, { recursive: true });
		if (existsSync(this.storePath)) {
			try {
				const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
				for (const t of Array.isArray(raw?.tasks) ? raw.tasks : []) {
					// 重启恢复:Worker/会话为 daemon 运行期实体,非终态卡一律记中断
					if (OPEN_STATUSES.has(t.status) || t.status === "awaiting-review") {
						t.status = "failed";
						t.summary = "daemon 重启,运行中断";
					}
					this.tasks.set(t.id, t);
				}
			} catch {
				/* 损坏回落空表 */
			}
		}
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	list(): OrchestrationTask[] {
		return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): OrchestrationTask | undefined {
		return this.tasks.get(id);
	}

	/** 手动清理卡片(仅终态) */
	dismiss(id: string): { ok: true } | { ok: false; error: string } {
		const t = this.tasks.get(id);
		if (!t) return { ok: false, error: `任务卡不存在:${id}` };
		if (OPEN_STATUSES.has(t.status) || t.status === "awaiting-review") return { ok: false, error: "任务未收束,不能清理" };
		this.tasks.delete(id);
		this.persist();
		this.emit({ type: "task.updated", taskId: id });
		return { ok: true };
	}

	/* ---------------- 建卡与归组 ---------------- */

	/** spawn_worker 桥调用归组:同 routerSessionId 的未收口卡 → 附加;否则新卡(聊天/手动) */
	attachWorker(input: { routerSessionId?: string; workerId: string; objective: string; workspaceId?: string; source?: "chat" | "manual" }): OrchestrationTask {
		if (input.routerSessionId) {
			for (const t of this.tasks.values()) {
				if (t.routerSessionId === input.routerSessionId && OPEN_STATUSES.has(t.status)) {
					if (!t.workerIds.includes(input.workerId)) t.workerIds.push(input.workerId);
					t.updatedAt = Date.now();
					this.persist();
					this.emit({ type: "task.updated", taskId: t.id });
					return t;
				}
			}
		}
		const now = Date.now();
		const task: OrchestrationTask = {
			id: `task-${randomUUID().slice(0, 8)}`,
			title: input.objective.split("\n")[0].slice(0, 60) || "(无目标)",
			objective: input.objective,
			source: input.source ?? "chat",
			status: "running",
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			workerIds: [input.workerId],
			...(input.routerSessionId ? { routerSessionId: input.routerSessionId } : {}),
			createdAt: now,
			updatedAt: now,
		};
		return this.put(task);
	}

	/** 竞赛建卡(races.start 调用) */
	beginRace(input: { raceId: string; objective: string; workspaceId?: string; workerIds: string[] }): OrchestrationTask {
		const now = Date.now();
		return this.put({
			id: `task-${randomUUID().slice(0, 8)}`,
			title: `竞赛:${input.objective.split("\n")[0].slice(0, 50)}`,
			objective: input.objective,
			source: "race",
			status: "running",
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			workerIds: [...input.workerIds],
			raceId: input.raceId,
			createdAt: now,
			updatedAt: now,
		});
	}

	private put(task: OrchestrationTask): OrchestrationTask {
		this.tasks.set(task.id, task);
		// 容量:超出上限淘汰最旧终态卡
		const max = this.deps.maxTasks ?? 200;
		if (this.tasks.size > max) {
			const terminal = [...this.tasks.values()]
				.filter((t) => !OPEN_STATUSES.has(t.status) && t.status !== "awaiting-review")
				.sort((a, b) => a.updatedAt - b.updatedAt);
			for (const t of terminal.slice(0, this.tasks.size - max)) this.tasks.delete(t.id);
		}
		this.persist();
		this.emit({ type: "task.updated", taskId: task.id });
		return task;
	}

	/* ---------------- 推进 ---------------- */

	/** Worker 池更新:找归属卡推进(聊天卡在 Worker 全收束且会话已 settle/超时陈旧时收口) */
	onWorkerUpdate(rec: { id: string; status: string; objective?: string; summary?: string; error?: string; verified?: string; durationMs?: number; routerSessionId?: string }) {
		const task = [...this.tasks.values()].find((t) => t.workerIds.includes(rec.id));
		if (!task) return;
		if (!task.objective && rec.objective) task.objective = rec.objective;
		// 摘要:最后一个有产出的 Worker
		if (rec.summary) task.summary = rec.summary.slice(-300);
		if (rec.error && !rec.summary) task.summary = `错误:${rec.error.slice(-200)}`;
		this.recomputeWorkers(task);
	}

	private recomputeWorkers(task: OrchestrationTask) {
		const workers = task.workerIds.map((id) => this.workerLookup?.(id)).filter(Boolean) as Array<{ status: string }>;
		if (!workers.length) return;
		const terminal = workers.every((w) => WORKER_TERMINAL.has(w.status));
		const anyActive = workers.some((w) => w.status === "queued" || w.status === "running");
		if (anyActive) {
			this.touch(task, "running");
			return;
		}
		if (!terminal) {
			this.touch(task, "running");
			return;
		}
		// 全收束:聊天卡等会话 settle(或 30min 陈旧)再终态;其余源各自事件推进
		const stale = Date.now() - task.updatedAt > 30 * 60_000;
		if (task.source === "chat" && !stale && task.status === "running") {
			// 轮未收口:保持 running(Router 可能在汇总/续派),仅刷新
			task.updatedAt = Date.now();
			this.persist();
			this.emit({ type: "task.updated", taskId: task.id });
			return;
		}
		this.finalizeWorkers(task);
	}

	private finalizeWorkers(task: OrchestrationTask) {
		const workers = task.workerIds.map((id) => this.workerLookup?.(id)).filter(Boolean) as Array<{ status: string; verified?: string }>;
		const allFailed = workers.length > 0 && workers.every((w) => w.status !== "done");
		const specRed = workers.length > 0 && workers.every((w) => w.status === "done" && w.verified === "red");
		this.touch(task, allFailed || specRed ? "failed" : "done");
	}

	private workerLookup?: (workerId: string) => { status: string; verified?: string } | undefined;

	/** daemon 注入 Worker 查询(orchestrator.get) */
	bindWorkerLookup(fn: (workerId: string) => { status: string; verified?: string } | undefined) {
		this.workerLookup = fn;
	}

	/** 宿主事件流入:automation.run / race.updated / agent.settled */
	handleHostEvent(e: HostEvent) {
		if (e.type === "automation.run") {
			const run = e.run;
			let task = [...this.tasks.values()].find((t) => t.runId === run.id);
			if (!task) {
				// 首个事件即终态(如异常路径)也补卡,保证看板无缺口
				const name = this.deps.getAutomation?.(run.automationId)?.name ?? run.automationId;
				const now = Date.now();
				task = this.put({
					id: `task-${randomUUID().slice(0, 8)}`,
					title: `自动化:${name}`,
					objective: name,
					source: "automation",
					status: "running",
					automationId: run.automationId,
					runId: run.id,
					...(run.sessionId ? { routerSessionId: run.sessionId } : {}),
					workerIds: run.workerIds ? [...run.workerIds] : [],
					createdAt: now,
					updatedAt: now,
				});
			}
			if (!task) return;
			if (run.sessionId && !task.routerSessionId) task.routerSessionId = run.sessionId;
			if (run.workerIds?.length && task.workerIds.join() !== run.workerIds.join()) {
				task.workerIds = [...run.workerIds];
			}
			if (run.summary) task.summary = run.summary.slice(-300);
			if (run.error && !run.summary) task.summary = `错误:${run.error.slice(-200)}`;
			if (run.status === "ok") {
				// Router 分派的 run:等其 Worker 全收束再终态;无 Worker 的 run 立即终态;
				// 有 ids 但池中查无记录(事件早于池同步)→ 保守视为运行中
				if (!task.workerIds.length) {
					this.touch(task, "done");
				} else {
					const workers = task.workerIds.map((id) => this.workerLookup?.(id)).filter(Boolean) as Array<{ status: string }>;
					if (!workers.length || workers.some((w) => !WORKER_TERMINAL.has(w.status))) {
						this.touch(task, "running");
					} else {
						this.finalizeWorkers(task);
					}
				}
			} else if (run.status === "failed" || run.status === "timeout" || run.status === "aborted") {
				this.touch(task, run.status === "aborted" ? "cancelled" : "failed");
			} else {
				this.touch(task, "running");
			}
			return;
		}
		if (e.type === "race.updated") {
			const race = this.deps.getRace?.(e.raceId);
			if (!race) return;
			const task = [...this.tasks.values()].find((t) => t.raceId === race.id);
			if (!task) return;
			const ids = race.entries.map((en) => en.workerId);
			if (ids.join() !== task.workerIds.join()) task.workerIds = ids;
			const best = race.entries.filter((en) => typeof en.score === "number").sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
			if (best) task.summary = `最高分 ${best.score}(worker ${best.workerId})`;
			if (race.status === "running") this.touch(task, "running");
			else if (race.status === "awaiting-review") this.touch(task, "awaiting-review");
			else if (race.status === "resolved") this.touch(task, "done");
			else if (race.status === "cancelled") this.touch(task, "cancelled");
			return;
		}
		if (e.type === "agent.settled") {
			// 聊天轮收口:该会话名下的未收口聊天卡终态
			for (const t of [...this.tasks.values()]) {
				if (t.source === "chat" && t.routerSessionId === e.sessionId && OPEN_STATUSES.has(t.status)) {
					this.finalizeWorkers(t);
				}
			}
		}
	}

	private touch(task: OrchestrationTask, status: OrchestrationTask["status"]) {
		const prev = task.status;
		if (prev !== status) {
			task.status = status;
		}
		task.updatedAt = Date.now();
		this.persist();
		this.emit({ type: "task.updated", taskId: task.id });
		// open → 终态迁移一次性回调(任务经历写入)
		const wasOpen = OPEN_STATUSES.has(prev) || prev === "awaiting-review";
		const nowOpen = OPEN_STATUSES.has(task.status) || task.status === "awaiting-review";
		if (wasOpen && !nowOpen) {
			try {
				this.deps.onFinalize?.({ ...task });
			} catch {
				/* 回调异常不影响卡域 */
			}
		}
	}

	private persist() {
		writeFileSync(this.storePath, JSON.stringify({ tasks: this.list() }, null, "\t"));
	}
}
