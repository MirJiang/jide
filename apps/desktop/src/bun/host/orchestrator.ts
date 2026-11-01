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
	/** 投机执行(P2):后台静默修复,验证绿才提交进评审队列 */
	speculative?: boolean;
	/** 投机验证结论 */
	verified?: "green" | "red" | "skipped";
	/** 发起方会话 id(完成回喂目标;双轨:聊天会话或常驻 Router) */
	routerSessionId?: string;
	/** Watchdog 已提醒过(一次) */
	loopWarned?: boolean;
}

export interface OrchestratorDeps {
	host: {
		createSession(opts: { workspacePath: string; workspaceId?: string; model?: { provider: string; modelId: string }; orchestrator?: boolean }): Promise<{ sessionId: string }>;
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
		getWorkspace(projectId: string, workspaceId: string): { branch?: string } | undefined;
		createWorktree(repoId: string, name: string): Promise<{ ok: true; workspaceId: string; path: string } | { ok: false; error: string }>;
	};
	/** 投机执行:验证与提交进评审队列(与 AutomationManager 同一套语义) */
	verify?: {
		scanTests(cwd: string): string[];
		gitStatus(workspaceId: string): Promise<{ ok: true; changes: Array<{ path: string }> } | { ok: false; error: string }>;
		mapTests(changed: string[], all: string[]): string[];
		runTests(cwd: string, files: string[], total: number): Promise<{ ok: boolean; selected: number; total: number; results: Array<{ status: string }> }>;
		runChecks(workspaceId: string): Promise<{ ok: boolean; results: Array<{ passed: boolean; title: string }> }>;
		enqueueChecks(workspaceId: string, passed: number, total: number): void;
		commitAll(workspaceId: string, message: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }>;
		enqueueCommit(workspaceId: string, branch: string, sha: string, message: string): void;
	};
	/** Router/精判专用模型 key(空 = pi 默认);精判会话与投机 Worker 用 */
	getRouterModelKey?: () => string;
	/** 精判会话的工作目录(daemon runtime) */
	judgeCwd?: string;
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
	/** 投机执行(P2):隔离 worktree 静默修复,验证绿才提交进评审队列 */
	speculative?: boolean;
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

	/* ---------------- Worker 更新订阅(P3 竞赛管理器等) ---------------- */

	private workerUpdateCbs = new Set<(rec: WorkerRecord) => void>();

	onWorkerUpdate(cb: (rec: WorkerRecord) => void): () => void {
		this.workerUpdateCbs.add(cb);
		return () => this.workerUpdateCbs.delete(cb);
	}

	private notifyWorkerUpdate(rec: WorkerRecord) {
		for (const cb of this.workerUpdateCbs) {
			try {
				cb({ ...rec });
			} catch {
				/* 订阅者异常不影响池 */
			}
		}
	}

	/* ---------------- Router 注册与回喂 ---------------- */

	/** 扩展每次桥调用带上发起会话 id;首次见到即登记(兼容旧单槽回喂;主路径为按 Worker 回喂) */
	noteRouter(sessionId?: string) {
		if (sessionId && !this.routerSessionId) {
			this.routerSessionId = sessionId;
			this.deps.host.log("info", `编排 Router 已注册:${sessionId.slice(0, 8)}`);
		}
	}

	/** 按发起方回喂:优先该 Worker 自己的 routerSessionId,缺省回退旧单槽 */
	private async notifyRouter(text: string, rec?: WorkerRecord) {
		const rid = rec?.routerSessionId ?? this.routerSessionId;
		if (!rid) return;
		const st = this.deps.host.getSession(rid)?.status;
		try {
			if (st === "busy") await this.deps.host.steerSession(rid, text);
			else await this.deps.host.prompt(rid, text);
		} catch (err: any) {
			this.deps.host.log("warn", `Router 回喂失败:${err?.message ?? err}`);
		}
	}

	/* ---------------- 常驻 Router 会话(P3:双轨;自动来源统一入口) ---------------- */

	private persistentRouterId: string | null = null;

	/**
	 * 常驻 Router 会话(懒创建,亡了重建):automations/事件等自动来源经它拆解分派。
	 * cwd = runtime 根(与精判会话同),模型 = Router 专用模型(空则 pi 默认)。
	 */
	async ensureRouter(): Promise<string> {
		const st = this.persistentRouterId ? this.deps.host.getSession(this.persistentRouterId) : undefined;
		if (this.persistentRouterId && st && st.status !== "disposed") return this.persistentRouterId;
		const modelKey = this.deps.getRouterModelKey?.() ?? "";
		const model = modelKey ? (parseModelKey(modelKey) ?? undefined) : undefined;
		const entry = await this.deps.host.createSession({
			workspacePath: this.deps.judgeCwd ?? process.cwd(),
			model,
			orchestrator: true,
		});
		this.persistentRouterId = entry.sessionId;
		this.deps.host.log("info", `常驻 Router 会话就绪:${entry.sessionId.slice(0, 8)}`);
		return entry.sessionId;
	}

	/* ---------------- Trigger 模型精判(两级过滤第二级) ---------------- */

	private judgeSessionId: string | null = null;
	private judgeChain: Promise<boolean | null> = Promise.resolve(null);

	/**
	 * 日志粗筛命中后的模型精判:独立隐藏会话(Router 专用模型,不污染用户对话),
	 * 串行执行(同一会话不能并发轮次);失败/超时/解析不出 → null(调用方回退直推)。
	 */
	judgeLogHit(workspaceId: string, tail: string): Promise<boolean | null> {
		this.judgeChain = this.judgeChain.then(() => this.judgeOnce(workspaceId, tail));
		return this.judgeChain;
	}

	private async judgeOnce(_workspaceId: string, tail: string): Promise<boolean | null> {
		try {
			if (!this.judgeSessionId || this.deps.host.getSession(this.judgeSessionId)?.status === "disposed") {
				const modelKey = this.deps.getRouterModelKey?.() ?? "";
				const model = modelKey ? (parseModelKey(modelKey) ?? undefined) : undefined;
				const entry = await this.deps.host.createSession({
					workspacePath: this.deps.judgeCwd ?? process.cwd(),
					model,
				});
				this.judgeSessionId = entry.sessionId;
			}
			const sid = this.judgeSessionId;
			let unsub = () => {};
			const settledP = new Promise<"settled">((resolve) => {
				unsub = this.deps.host.onSettled(sid, () => resolve("settled"));
			});
			await this.deps.host.prompt(
				sid,
				`你是日志事件精判器。判断以下 dev server 日志是否值得【立即打断】正在该工作区干活的 agent(仅当错误可能与进行中工作相关且现在知道有价值;普通噪音一律 false)。只回复一行 JSON:{"interrupt":true/false,"reason":"一句话"}\n日志尾部:\n${tail.slice(0, 1500)}`,
			);
			const outcome = await Promise.race([
				settledP,
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 25_000)),
			]);
			unsub();
			if (outcome === "timeout") {
				await this.deps.host.abort(sid).catch(() => {});
				return null;
			}
			const snap = this.deps.host.getSnapshot(sid);
			const last = [...(snap?.messages ?? [])].reverse().find((m) => m.role === "assistant");
			const m = /\{[^{}]*\}/.exec(last?.text ?? "");
			if (!m) return null;
			const parsed = JSON.parse(m[0]);
			return typeof parsed.interrupt === "boolean" ? parsed.interrupt : null;
		} catch {
			return null;
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
			...(opts.speculative ? { speculative: true } : {}),
			...(opts.routerSessionId ? { routerSessionId: opts.routerSessionId } : {}),
		};
		this.workers.set(rec.id, rec);
		this.notifyWorkerUpdate(rec);
		this.queue.push({ rec, objective: opts.objective, modelKey: opts.modelKey, timeoutMin: opts.timeoutMin ?? this.deps.workerTimeoutMin ?? 30 });
		this.pump();
		return rec;
	}

	private pump() {
		const cap = this.deps.maxConcurrent ?? 3;
		while (this.active < cap && this.queue.length) {
			const item = this.queue.shift()!;
			this.active++;
			void this.execWorker(item.rec, item.objective, item.modelKey, item.timeoutMin, item.rec.speculative).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	private async execWorker(rec: WorkerRecord, objective: string, modelKey?: string, timeoutMin: number, speculative?: boolean) {
		this.running.set(rec.id, rec.sessionId);
		rec.status = "running";
		this.notifyWorkerUpdate(rec);
		if (speculative) {
			rec.speculative = true;
			// 投机执行:必须落隔离 worktree(验证绿才提交,W5/W6 门禁语义)
			const loc0 = this.deps.workspaces.locate(rec.workspaceId);
			if (!loc0.projectId) throw new Error("投机执行要求目标为 git 仓库工作区");
			const wt = await this.deps.workspaces.createWorktree(loc0.projectId, `spec-${rec.id.slice(2)}-${Date.now().toString(36)}`);
			if (!wt.ok) throw new Error(`投机工作区创建失败:${wt.error}`);
			rec.workspaceId = wt.workspaceId;
			this.emit({ type: "host.log", level: "info", message: `投机 Worker ${rec.id} 于隔离 worktree ${wt.branch ?? ""} 启动` });
		}
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

			// 投机收口:验证绿 → 自动提交进评审队列;红 → 原样保留,不进主线(W6 门禁)
			if (speculative && rec.status === "done" && this.deps.verify) {
				const v = this.deps.verify;
				const loc2 = this.deps.workspaces.locate(rec.workspaceId);
				if (!loc2.cwd) throw new Error("投机工作区丢失");
				let green = true;
				const all = v.scanTests(loc2.cwd);
				const st = await v.gitStatus(rec.workspaceId);
				const changed = st.ok ? st.changes.map((c) => c.path) : [];
				const selected = v.mapTests(changed, all);
				if (selected.length) {
					const t = await v.runTests(loc2.cwd, selected, all.length);
					const passed = t.results.filter((x) => x.status === "pass").length;
					if (t.results.length && passed < t.results.length) green = false;
					rec.summary = `测试 ${passed}/${t.results.length}${rec.summary ? ` · ${rec.summary.slice(0, 300)}` : ""}`;
				}
				const c = await v.runChecks(rec.workspaceId);
				if (c.ok && c.results.length) {
					const cPass = c.results.filter((x) => x.passed).length;
					v.enqueueChecks(rec.workspaceId, cPass, c.results.length);
					if (cPass < c.results.length) green = false;
					rec.summary = `检查项 ${cPass}/${c.results.length} · ${rec.summary ?? ""}`;
				}
				rec.verified = green ? "green" : "red";
				if (green) {
					const cm = await v.commitAll(rec.workspaceId, `Agent · 投机修复:${objective.slice(0, 60)}`);
					if (cm.ok) {
						const info = this.deps.workspaces.getWorkspace(loc2.projectId!, rec.workspaceId);
						v.enqueueCommit(rec.workspaceId, info?.branch ?? "", cm.sha, `Agent · 投机修复:${objective.slice(0, 60)}`);
						rec.summary = `已提交 ${cm.sha.slice(0, 8)}(待评审) · ${rec.summary ?? ""}`;
					} else if (cm.error !== "nothing to commit") {
						rec.verified = "red";
						rec.error = `提交失败:${cm.error}`;
					}
				}
			}
		} catch (err: any) {
			rec.status = "failed";
			rec.error = String(err?.message ?? err);
		} finally {
			rec.durationMs = Date.now() - rec.startedAt;
			this.running.delete(rec.id);
			this.notifyWorkerUpdate(rec);
			this.emit({ type: "host.log", level: rec.status === "done" ? "info" : "warn", message: `Worker ${rec.id} ${rec.status}${rec.error ? `:${rec.error.slice(0, 80)}` : ""}` });
			await this.notifyRouter(
				rec.status === "done"
					? `【Worker ${rec.id} 完成】目标:${rec.objective.slice(0, 120)}\n结果摘要:${rec.summary ?? "(无文本输出)"}`
					: `【Worker ${rec.id} ${rec.status}】目标:${rec.objective.slice(0, 120)}${rec.error ? `\n原因:${rec.error}` : ""}`,
				rec,
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
		await this.notifyRouter(`【Worker ${w.id} ${w.status}】${w.summary ?? w.error ?? ""}`, w);
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
					await this.notifyRouter(`【Watchdog】Worker ${w.id} 超时已中断:${w.objective.slice(0, 80)}`, w);
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
