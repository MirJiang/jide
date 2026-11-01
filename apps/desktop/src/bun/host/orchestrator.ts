/**
 * OrchestratorManager — P2 编排层(DeepSeek Router/Worker 的单机形态)
 *
 * 当前对话即 Router:orchestrator 会话获得委派工具(jide-orchestrator 扩展),
 * 把子任务派给 Worker 池;Worker 在目标工作区建独立 pi 会话执行。
 *  - spawn_worker:排队(每全局并发上限,默认 3)→ 建会话 → prompt → 等 settled;
 *  - 完成回喂:settled 后把结果摘要 steer(忙碌)/ prompt(空闲)给 Router —— Router
 *    收到即开新一轮消化结果(DeepSeek "Worker 订阅直推、不走 Router 中转"同哲学);
 *  - wait_workers:Router 轮内同步等待若干 Worker 收束(上限 10min);
 *  - Watchdog:超时 abort;同 Worker 连续同名词工具调用(默认 4 次)→ 一次提醒 steer。
 * Worker 记录为 daemon 运行期实体(不落盘;历史靠会话文件)。
 */

import { randomUUID } from "node:crypto";
import type { HostEvent } from "@jide/contracts";
import { parseModelKey } from "@jide/contracts";
import type { EmitFn } from "./agent-host";

export interface WorkerRecord {
	id: string;
	sessionId: string;
	workspaceId: string;
	objective: string;
	status: "queued" | "running" | "done" | "failed" | "timeout" | "aborted";
	startedAt: number;
	durationMs?: number;
	summary?: string;
	error?: string;
	/** Watchdog 已提醒过(一次) */
	loopWarned?: boolean;
}

export interface OrchestratorDeps {
	host: {
		createSession(opts: { workspacePath: string; workspaceId?: string; model?: { provider: string; modelId: string } }): Promise<{ sessionId: string }>;
		prompt(sessionId: string, text: string): Promise<void>;
		steerSession(sessionId: string, text: string): Promise<void>;
		abort(sessionId: string): Promise<void>;
		getSession(sessionId: string): { status: string } | undefined;
		getSnapshot(sessionId: string): { messages: Array<{ role: string; text: string }> } | undefined;
		onSettled(sessionId: string, cb: () => void): () => void;
		log(level: "info" | "warn" | "error", message: string): void;
	};
	workspaces: {
		locate(workspaceId: string): { cwd: string | null; projectId: string | null };
	};
	maxConcurrent?: number;
	workerTimeoutMin?: number;
	/** 同名词工具连续几次判定疑似循环(默认 4) */
	loopThreshold?: number;
}

export interface SpawnWorkerOptions {
	objective: string;
	/** 缺省 = Router 自己的工作区(扩展透传) */
	workspaceId?: string;
	modelKey?: string;
	timeoutMin?: number;
	/** 发起方 Router 会话 id(完成回喂目标;扩展经 ctx 注入) */
	routerSessionId?: string;
}

export class OrchestratorManager {
	private workers = new Map<string, WorkerRecord>();
	private queue: Array<{ rec: WorkerRecord; objective: string; modelKey?: string; timeoutMin: number }> = [];
	private active = 0;
	private running = new Map<string, string>(); // workerId → sessionId
	private routerSessionId: string | null = null;
	private loopTracker = new Map<string, string[]>();
	private watchdog: ReturnType<typeof setInterval> | null = null;
	private emit: EmitFn = () => {};
	private readonly deps: OrchestratorDeps;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	/** daemon 生命周期:停 Watchdog(运行中的 Worker 不中断) */
	dispose() {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
	}

	list(): WorkerRecord[] {
		return [...this.workers.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): WorkerRecord | undefined {
		return this.workers.get(id);
	}

	/* ---------------- Router 注册与回喂 ---------------- */

	/** 扩展每次桥调用带上发起会话 id;首次见到即注册为 Router(单会话语义下即当前对话) */
	noteRouter(sessionId?: string) {
		if (sessionId && !this.routerSessionId) {
			this.routerSessionId = sessionId;
			this.deps.host.log("info", `编排 Router 已注册:${sessionId.slice(0, 8)}`);
		}
	}

	private async notifyRouter(text: string) {
		const rid = this.routerSessionId;
		if (!rid) return;
		const st = this.deps.host.getSession(rid)?.status;
		try {
			if (st === "busy") await this.deps.host.steerSession(rid, text);
			else await this.deps.host.prompt(rid, text);
		} catch (err: any) {
			this.deps.host.log("warn", `Router 回喂失败:${err?.message ?? err}`);
		}
	}

	/* ---------------- 委派 ---------------- */

	spawnWorker(opts: SpawnWorkerOptions): WorkerRecord {
		if (!opts.objective?.trim()) throw new Error("objective 不能为空");
		if (opts.routerSessionId) this.noteRouter(opts.routerSessionId);
		const rec: WorkerRecord = {
			id: `w-${randomUUID().slice(0, 8)}`,
			sessionId: "",
			workspaceId: opts.workspaceId ?? "",
			objective: opts.objective,
			status: "queued",
			startedAt: Date.now(),
		};
		this.workers.set(rec.id, rec);
		this.queue.push({ rec, objective: opts.objective, modelKey: opts.modelKey, timeoutMin: opts.timeoutMin ?? this.deps.workerTimeoutMin ?? 30 });
		this.pump();
		return rec;
	}

	private pump() {
		const cap = this.deps.maxConcurrent ?? 3;
		while (this.active < cap && this.queue.length) {
			const item = this.queue.shift()!;
			this.active++;
			void this.execWorker(item.rec, item.objective, item.modelKey, item.timeoutMin).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	private async execWorker(rec: WorkerRecord, objective: string, modelKey?: string, timeoutMin: number) {
		this.running.set(rec.id, rec.sessionId);
		rec.status = "running";
		this.emit({ type: "host.log", level: "info", message: `Worker ${rec.id} 启动(目标:${objective.slice(0, 60)})` });
		try {
			const loc = this.deps.workspaces.locate(rec.workspaceId);
			if (!loc.cwd) throw new Error("目标工作区不存在");
			const model = modelKey ? (parseModelKey(modelKey) ?? undefined) : undefined;
			const entry = await this.deps.host.createSession({ workspacePath: loc.cwd, workspaceId: rec.workspaceId, model });
			rec.sessionId = entry.sessionId;
			this.running.set(rec.id, rec.sessionId);

			let unsub = () => {};
			const settledP = new Promise<"settled">((resolve) => {
				unsub = this.deps.host.onSettled(entry.sessionId, () => resolve("settled"));
			});
			const timeoutMs = timeoutMin * 60_000;
			await this.deps.host.prompt(entry.sessionId, objective);
			const outcome = await Promise.race([
				settledP,
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
			]);
			unsub();

			if (outcome === "timeout") {
				await this.deps.host.abort(entry.sessionId).catch(() => {});
				rec.status = "timeout";
				rec.error = `超时(${timeoutMin} 分钟),已中断`;
			} else {
				rec.status = "done";
				const snap = this.deps.host.getSnapshot(entry.sessionId);
				const lastAssistant = [...(snap?.messages ?? [])].reverse().find((m) => m.role === "assistant");
				rec.summary = lastAssistant?.text?.slice(-600);
			}
		} catch (err: any) {
			rec.status = "failed";
			rec.error = String(err?.message ?? err);
		} finally {
			rec.durationMs = Date.now() - rec.startedAt;
			this.running.delete(rec.id);
			this.emit({ type: "host.log", level: rec.status === "done" ? "info" : "warn", message: `Worker ${rec.id} ${rec.status}${rec.error ? `:${rec.error.slice(0, 80)}` : ""}` });
			await this.notifyRouter(
				rec.status === "done"
					? `【Worker ${rec.id} 完成】目标:${rec.objective.slice(0, 120)}\n结果摘要:${rec.summary ?? "(无文本输出)"}`
					: `【Worker ${rec.id} ${rec.status}】目标:${rec.objective.slice(0, 120)}${rec.error ? `\n原因:${rec.error}` : ""}`,
			);
			this.pump();
		}
	}

	/** 轮内同步等待若干 Worker 收束;返回终态快照(超时返回当前状态) */
	async waitWorkers(workerIds: string[], timeoutSec = 300): Promise<WorkerRecord[]> {
		const ids = workerIds.length ? workerIds : [...this.workers.keys()];
		const deadline = Date.now() + Math.min(timeoutSec, 600) * 1000;
		const terminal = (s: WorkerRecord["status"]) => s !== "queued" && s !== "running";
		while (Date.now() < deadline) {
			const all = ids.map((id) => this.workers.get(id)).filter(Boolean) as WorkerRecord[];
			if (all.length && all.every((w) => terminal(w.status))) return all;
			await new Promise((r) => setTimeout(r, 120));
		}
		return ids.map((id) => this.workers.get(id)).filter(Boolean) as WorkerRecord[];
	}

	async sendToWorker(workerId: string, text: string) {
		const w = this.workers.get(workerId);
		if (!w?.sessionId) throw new Error(`Worker 不存在:${workerId}`);
		const st = this.deps.host.getSession(w.sessionId)?.status;
		if (st === "busy") throw new Error("该 Worker 上一轮仍在运行");
		await this.deps.host.prompt(w.sessionId, text);
		if (w.status !== "running") {
			w.status = "running";
			// 复用会话追加任务:重新等待收束(超时沿用全局默认)
			void this.watchSettled(w);
		}
	}

	async stopWorker(workerId: string) {
		const w = this.workers.get(workerId);
		if (!w) throw new Error(`Worker 不存在:${workerId}`);
		if (w.sessionId) await this.deps.host.abort(w.sessionId).catch(() => {});
		w.status = "aborted";
		w.durationMs = Date.now() - w.startedAt;
	}

	/** 追加任务后的二次收束等待(超时/摘要/回喂) */
	private async watchSettled(w: WorkerRecord) {
		let unsub = () => {};
		const settledP = new Promise<"settled">((resolve) => {
			unsub = this.deps.host.onSettled(w.sessionId, () => resolve("settled"));
		});
		const outcome = await Promise.race([
			settledP,
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), (this.deps.workerTimeoutMin ?? 30) * 60_000)),
		]);
		unsub();
		if (outcome === "timeout") {
			await this.deps.host.abort(w.sessionId).catch(() => {});
			w.status = "timeout";
		} else {
			w.status = "done";
			const snap = this.deps.host.getSnapshot(w.sessionId);
			const last = [...(snap?.messages ?? [])].reverse().find((m) => m.role === "assistant");
			w.summary = last?.text?.slice(-600);
		}
		w.durationMs = Date.now() - w.startedAt;
		await this.notifyRouter(`【Worker ${w.id} ${w.status}】${w.summary ?? w.error ?? ""}`);
	}

	/* ---------------- Watchdog ---------------- */

	startWatchdog() {
		if (this.watchdog) return;
		this.watchdog = setInterval(() => this.watchTick(), 30_000);
	}

	private watchTick() {
		const timeoutMin = this.deps.workerTimeoutMin ?? 30;
		const now = Date.now();
		for (const w of this.workers.values()) {
			if (w.status !== "running") continue;
			if (now - w.startedAt > timeoutMin * 60_000) {
				void (async () => {
					await this.deps.host.abort(w.sessionId).catch(() => {});
					w.status = "timeout";
					w.error = `Watchdog:超时(${timeoutMin} 分钟),已中断`;
					this.emit({ type: "host.log", level: "warn", message: `Watchdog:Worker ${w.id} 超时中断` });
					await this.notifyRouter(`【Watchdog】Worker ${w.id} 超时已中断:${w.objective.slice(0, 80)}`);
				})();
			}
		}
	}

	/** 宿主事件流入:Worker 会话的连续同名词工具调用检测(每 Worker 只提醒一次) */
	handleHostEvent(e: HostEvent) {
		if (e.type !== "agent.tool" || e.phase !== "start") return;
		let workerId: string | null = null;
		for (const [id, sid] of this.running) {
			if (sid === e.sessionId) {
				workerId = id;
				break;
			}
		}
		if (!workerId) return;
		const w = this.workers.get(workerId);
		if (!w || w.loopWarned) return;
		const seq = this.loopTracker.get(e.sessionId) ?? [];
		seq.push(e.toolName);
		if (seq.length > 8) seq.shift();
		this.loopTracker.set(e.sessionId, seq);
		const threshold = this.deps.loopThreshold ?? 4;
		const tail = seq.slice(-threshold);
		if (tail.length === threshold && tail.every((t) => t === tail[0])) {
			w.loopWarned = true;
			void this.deps.host.steerSession(e.sessionId, "【Watchdog】检测到连续重复的工具调用;请停下评估当前策略是否有效,若无效请换思路或向用户说明。").catch(() => {});
			this.emit({ type: "host.log", level: "warn", message: `Watchdog:Worker ${workerId} 疑似无效循环(${tail[0]} ×${threshold}),已提醒` });
		}
	}
}
