/**
 * AutomationManager — 自动化域(P1.5,完整功能)
 *
 * 到点/事件 → 目标工作区建会话跑 prompt →(可选)自动 test_run+checks → W6 评审队列。
 *  - 调度:cron(标准 5 字段)/ daily / weekdays,daemon 内 30s tick + 分钟去重;
 *  - 事件触发:test-failed / checks-failed(复用宿主事件流),每任务 10 分钟冷却防自激励循环;
 *  - 并发:每任务互斥 + 全局并发上限(队列 FIFO,不丢弃);
 *  - 目标:repo = 每 run 新建隔离 worktree(自动提交+评审语义);workspace = 指定工作区;
 *  - 会话:可复用(reuseSession,会话亡了自动重建);
 *  - 历史:automations.json 落盘,每任务保留 50 条。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseModelKey, type Automation, type AutomationRun, type AutomationStore, type HostEvent } from "@jide/contracts";
import type { EmitFn } from "./agent-host";

/* ---------------- 调度匹配(导出供测试) ---------------- */

export interface CronFields {
	m: Set<number>;
	h: Set<number>;
	dom: Set<number>;
	mon: Set<number>;
	dow: Set<number>;
	domRestricted: boolean;
	dowRestricted: boolean;
}

/** 解析标准 5 字段 cron(分 时 日 月 周;支持 * , - /);不合法返回 null */
export function parseCron(expr: string): CronFields | null {
	const f = expr.trim().split(/\s+/);
	if (f.length !== 5) return null;
	const parse = (spec: string, min: number, max: number): Set<number> | null => {
		const out = new Set<number>();
		for (const part of spec.split(",")) {
			let body = part;
			let step = 1;
			const si = part.indexOf("/");
			if (si >= 0) {
				body = part.slice(0, si);
				step = Number(part.slice(si + 1));
				if (!Number.isInteger(step) || step < 1) return null;
			}
			let lo = min;
			let hi = max;
			if (body !== "*") {
				if (body.includes("-")) {
					const [a, b] = body.split("-");
					lo = Number(a);
					hi = Number(b);
				} else {
					lo = hi = Number(body);
				}
			}
			if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
			for (let v = lo; v <= hi; v += step) out.add(v);
		}
		return out;
	};
	const m = parse(f[0], 0, 59);
	const h = parse(f[1], 0, 23);
	const dom = parse(f[2], 1, 31);
	const mon = parse(f[3], 1, 12);
	const dow = parse(f[4], 0, 6);
	if (!m || !h || !dom || !mon || !dow) return null;
	return { m, h, dom, mon, dow, domRestricted: f[2] !== "*", dowRestricted: f[4] !== "*" };
}

/** 标准 5 字段 cron 匹配;dom 与 dow 均受限时取 OR(标准语义) */
export function cronMatch(expr: string, d: Date): boolean {
	const c = parseCron(expr);
	if (!c) return false;
	if (!c.m.has(d.getMinutes()) || !c.h.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
	if (c.domRestricted && c.dowRestricted) return c.dom.has(d.getDate()) || c.dow.has(d.getDay());
	return c.dom.has(d.getDate()) && c.dow.has(d.getDay());
}

/** 调度型触发器是否在时刻 d 到期(分钟精度) */
export function scheduleDue(trigger: Automation["trigger"], d: Date): boolean {
	if (trigger.kind === "cron") return cronMatch(trigger.expr, d);
	if (trigger.kind === "daily" || trigger.kind === "weekdays") {
		const m = /^(\d{1,2}):(\d{2})$/.exec(trigger.time);
		if (!m) return false;
		if (trigger.kind === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) return false;
		return d.getHours() === Number(m[1]) && d.getMinutes() === Number(m[2]);
	}
	return false;
}

/* ---------------- 依赖面(全部注入,可测) ---------------- */

export interface AutomationDeps {
	host: {
		createSession(opts: { workspacePath: string; workspaceId?: string; model?: { provider: string; modelId: string } }): Promise<{ sessionId: string }>;
		prompt(sessionId: string, text: string): Promise<void>;
		abort(sessionId: string): Promise<void>;
		getSession(sessionId: string): { status: string } | undefined;
		getSnapshot(sessionId: string): { messages: Array<{ role: string; text: string }> } | undefined;
		onSettled(sessionId: string, cb: () => void): () => void;
		log(level: "info" | "warn" | "error", message: string): void;
	};
	workspaces: {
		createWorktree(repoId: string, name: string): Promise<{ ok: true; workspaceId: string; path: string } | { ok: false; error: string }>;
		locate(workspaceId: string): { cwd: string | null; projectId: string | null };
	};
	verify: {
		scanTests(cwd: string): string[];
		gitStatus(workspaceId: string): Promise<{ ok: true; changes: Array<{ path: string }> } | { ok: false; error: string }>;
		mapTests(changed: string[], all: string[]): string[];
		runTests(cwd: string, files: string[], total: number): Promise<{ ok: boolean; selected: number; total: number; results: Array<{ status: string }> }>;
		runChecks(workspaceId: string): Promise<{ ok: boolean; results: Array<{ passed: boolean; title: string }> }>;
		enqueueChecks(workspaceId: string, passed: number, total: number): void;
	};
	/** Router 分派(P3):常驻 Router 会话拆解 → Worker 池;缺省无 = dispatch "router" 回退直执 */
	orchestrator?: {
		ensureRouter(): Promise<string>;
		onWorkerUpdate(cb: (w: { id: string; routerSessionId?: string; status: string }) => void): () => void;
		waitWorkers(ids: string[], timeoutSec?: number): Promise<Array<{ id: string; status: string }>>;
	};
	runtimeRoot: string;
	/** 全局并发上限(默认 2) */
	maxConcurrent?: number;
	/** 事件触发冷却(分钟,防自激励循环;默认 10) */
	eventCooldownMin?: number;
	/** timeoutMin 校验下限(测试可调低;默认 1 分钟) */
	timeoutMinFloor?: number;
	/** Router 分派 spawn 窗口(ms,窗口内无 Worker 即回退直执;缺省 = min(120s, max(30s, timeout/3))) */
	routerSpawnWindowMs?: number;
}

const EMPTY_STORE: AutomationStore = { automations: [], runs: {} };

export class AutomationManager {
	private store: AutomationStore = { automations: [], runs: {} };
	private storePath: string;
	private emit: EmitFn = () => {};
	private timer: ReturnType<typeof setInterval> | null = null;
	/** `${autoId}@${minuteKey}` → firedAt(防同分钟重复触发) */
	private firedMinutes = new Map<string, number>();
	/** 运行中任务(每任务互斥) */
	private running = new Set<string>();
	/** 全局并发队列 */
	private queue: Array<{ a: Automation; rec: AutomationRun }> = [];
	private active = 0;
	/** 复用会话:autoId → sessionId */
	private reused = new Map<string, string>();
	/** 事件触发最近运行时间(冷却) */
	private lastEventRunAt = new Map<string, number>();

	constructor(private deps: AutomationDeps) {
		this.storePath = join(deps.runtimeRoot, "automations.json");
		mkdirSync(deps.runtimeRoot, { recursive: true });
		if (existsSync(this.storePath)) {
			try {
				const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
				this.store = {
					automations: Array.isArray(raw?.automations) ? raw.automations : [],
					runs: raw?.runs && typeof raw.runs === "object" ? raw.runs : {},
				};
			} catch {
				/* 损坏回落空表 */
			}
		}
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	/** daemon/app 生命周期:停调度钟(运行中的轮次不中断) */
	dispose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/* ---------------- 查询与 CRUD ---------------- */

	list(): AutomationStore {
		return { automations: [...this.store.automations], runs: this.store.runs };
	}

	get(id: string): Automation | undefined {
		return this.store.automations.find((a) => a.id === id);
	}

	/** 新建/更新;校验失败抛错(UI 层转 ok:false) */
	save(input: Automation): Automation {
		const a = this.validate(input);
		const existing = a.id ? this.store.automations.findIndex((x) => x.id === a.id) : -1;
		if (existing >= 0) {
			this.store.automations[existing] = { ...this.store.automations[existing], ...a, id: this.store.automations[existing].id, createdAt: this.store.automations[existing].createdAt };
		} else {
			const created: Automation = { ...a, id: `auto-${randomUUID().slice(0, 8)}`, createdAt: Date.now() };
			this.store.automations.push(created);
			this.emit({ type: "automation.updated", automationId: created.id });
			this.persist();
			return created;
		}
		this.emit({ type: "automation.updated", automationId: a.id });
		this.persist();
		return this.store.automations[existing];
	}

	delete(id: string) {
		const before = this.store.automations.length;
		this.store.automations = this.store.automations.filter((a) => a.id !== id);
		delete this.store.runs[id];
		this.reused.delete(id);
		if (this.store.automations.length !== before) {
			this.emit({ type: "automation.updated", automationId: id });
			this.persist();
		}
	}

	private validate(a: Automation): Automation {
		if (!a?.name?.trim()) throw new Error("名称不能为空");
		if (!a?.prompt?.trim()) throw new Error("任务描述(prompt)不能为空");
		const t = a.trigger;
		if (!t) throw new Error("缺少触发器");
		if (t.kind === "cron") {
			if (!parseCron(t.expr)) throw new Error(`cron 表达式不合法:${t.expr}`);
		} else if (t.kind === "daily" || t.kind === "weekdays") {
			if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(t.time)) throw new Error(`时间不合法(须 HH:mm):${t.time}`);
		} else if (t.kind === "event") {
			if (t.type !== "test-failed" && t.type !== "checks-failed") throw new Error("事件类型不合法");
		} else {
			throw new Error("触发器类型不合法");
		}
		if (!a.target || (a.target.kind !== "repo" && a.target.kind !== "workspace")) throw new Error("目标不合法");
		if (a.target.kind === "repo" && !a.target.repoId) throw new Error("repo 目标缺少 repoId");
		if (a.target.kind === "workspace" && !a.target.workspaceId) throw new Error("workspace 目标缺少 workspaceId");
		if (a.modelKey && !parseModelKey(a.modelKey)) throw new Error(`模型 key 不合法:${a.modelKey}`);
		return {
			...a,
			enabled: a.enabled !== false,
			reuseSession: a.reuseSession === true,
			autoVerify: a.autoVerify !== false,
			dispatch: a.dispatch === "router" ? "router" : "direct",
			timeoutMin: Math.min(720, Math.max(this.deps.timeoutMinFloor ?? 1, Number(a.timeoutMin) || 30)),
		};
	}

	/* ---------------- 调度 ---------------- */

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), 30_000);
		this.tick();
	}

	private tick() {
		const now = new Date();
		// 清理过期去重键(>5 分钟)
		for (const [k, at] of this.firedMinutes) {
			if (now.getTime() - at > 5 * 60_000) this.firedMinutes.delete(k);
		}
		for (const a of this.store.automations) {
			if (!a.enabled || a.trigger.kind === "event") continue;
			if (!scheduleDue(a.trigger, now)) continue;
			const key = `${a.id}@${now.getHours()}:${now.getMinutes()}`;
			if (this.firedMinutes.has(key)) continue;
			this.firedMinutes.set(key, now.getTime());
			void this.run(a.id, "schedule").catch((e) => this.deps.host.log("error", `自动化「${a.name}」调度失败:${e?.message ?? e}`));
		}
	}

	/** 宿主事件流入(事件触发:test-failed / checks-failed,带冷却) */
	handleHostEvent(e: HostEvent) {
		if (e.type !== "test.progress" && e.type !== "checks.updated") return;
		const kind = e.type === "test.progress" ? ("test-failed" as const) : ("checks-failed" as const);
		if (e.type === "test.progress") {
			if (e.phase !== "done" || !(e.failed > 0)) return;
		} else {
			if (!e.results.length || e.results.every((r) => r.passed)) return;
		}
		const now = Date.now();
		for (const a of this.store.automations) {
			if (!a.enabled || a.trigger.kind !== "event" || a.trigger.type !== kind) continue;
			const cooldown = (this.deps.eventCooldownMin ?? 10) * 60_000;
			const last = this.lastEventRunAt.get(a.id) ?? 0;
			if (now - last < cooldown) continue;
			const loc = this.deps.workspaces.locate(e.workspaceId);
			const match =
				a.target.kind === "workspace"
					? a.target.workspaceId === e.workspaceId
					: loc.projectId !== null && a.target.repoId === loc.projectId;
			if (!match) continue;
			this.lastEventRunAt.set(a.id, now);
			this.deps.host.log("info", `自动化「${a.name}」由事件触发(${kind})`);
			void this.run(a.id, "event").catch((err) => this.deps.host.log("error", `自动化「${a.name}」事件触发失败:${err?.message ?? err}`));
		}
	}

	/* ---------------- 运行引擎 ---------------- */

	/** 发起一轮(排队;立即返回 runId,状态经 automation.run 事件实时回推) */
	async run(automationId: string, trigger: AutomationRun["trigger"]): Promise<AutomationRun> {
		const a = this.get(automationId);
		if (!a) throw new Error(`自动化不存在:${automationId}`);
		if (this.running.has(automationId)) throw new Error(`「${a.name}」上一轮仍在运行`);
		const rec: AutomationRun = {
			id: `run-${randomUUID().slice(0, 8)}`,
			automationId,
			startedAt: Date.now(),
			status: "queued",
			trigger,
		};
		this.pushRun(automationId, rec);
		this.queue.push({ a, rec });
		this.pump();
		return rec;
	}

	private pump() {
		const cap = this.deps.maxConcurrent ?? 2;
		while (this.active < cap && this.queue.length) {
			const item = this.queue.shift()!;
			this.active++;
			void this.execRun(item.a, item.rec).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	private async execRun(a: Automation, rec: AutomationRun) {
		this.running.add(a.id);
		rec.status = "running";
		this.flushRun(rec);
		try {
			// 目标解析
			let workspaceId: string;
			let workspacePath: string;
			if (a.target.kind === "repo") {
				const wt = await this.deps.workspaces.createWorktree(a.target.repoId, `auto-${a.id.slice(-6)}-${Date.now().toString(36)}`);
				if (!wt.ok) throw new Error(`创建隔离工作区失败:${wt.error}`);
				workspaceId = wt.workspaceId;
				workspacePath = wt.path;
			} else {
				const loc = this.deps.workspaces.locate(a.target.workspaceId);
				if (!loc.cwd) throw new Error("目标工作区不存在");
				workspaceId = a.target.workspaceId;
				workspacePath = loc.cwd;
			}
			rec.workspaceId = workspaceId;
			this.flushRun(rec);

			// 分派:router = 提交常驻 Router 拆解分派 Worker 池;direct/fallback = 直连会话执行
			const wantRouter = a.dispatch === "router" && !!this.deps.orchestrator;
			let handled = false;
			if (wantRouter) {
				rec.dispatched = "router";
				handled = await this.execViaRouter(a, rec, workspaceId, workspacePath);
				if (!handled) {
					// Router 未接管(不可用/spawn 窗口无 Worker/轮次异常)→ 清残留,回退直执
					rec.dispatched = "fallback";
					rec.sessionId = undefined;
					rec.workerIds = undefined;
					rec.summary = undefined;
					rec.error = undefined;
					rec.status = "running";
					this.flushRun(rec);
				}
			} else {
				rec.dispatched = "direct";
			}
			if (!handled) await this.execDirect(a, rec, workspaceId, workspacePath);

			// 自动验证(结果失败不改 run 状态——run 完成,结论看字段;入评审队列人审)
			if (a.autoVerify && rec.status === "ok") {
				const loc = this.deps.workspaces.locate(workspaceId);
				if (loc.cwd) {
					const all = this.deps.verify.scanTests(loc.cwd);
					const st = await this.deps.verify.gitStatus(workspaceId);
					const changed = st.ok ? st.changes.map((c) => c.path) : [];
					const selected = this.deps.verify.mapTests(changed, all);
					if (selected.length) {
						const t = await this.deps.verify.runTests(loc.cwd, selected, all.length);
						const passed = t.results.filter((x) => x.status === "pass").length;
						rec.tests = { selected: t.selected, total: t.total, passed, failed: t.results.length - passed };
					}
					const c = await this.deps.verify.runChecks(workspaceId);
					if (c.ok && c.results.length) {
						this.deps.verify.enqueueChecks(workspaceId, c.results.filter((x) => x.passed).length, c.results.length);
						rec.checks = { total: c.results.length, passed: c.results.filter((x) => x.passed).length };
					}
				}
			}
		} catch (err: any) {
			rec.status = "failed";
			rec.error = String(err?.message ?? err);
		} finally {
			rec.durationMs = Date.now() - rec.startedAt;
			this.running.delete(a.id);
			this.flushRun(rec);
			this.pump();
		}
	}

	/** 直执(P1.5 原路径):目标工作区建会话跑 prompt(可复用会话) */
	private async execDirect(a: Automation, rec: AutomationRun, workspaceId: string, workspacePath: string) {
		// 会话(可复用;亡了重建)
		let sessionId: string;
		const reuse = a.reuseSession ? this.reused.get(a.id) : undefined;
		const snap = reuse ? this.deps.host.getSession(reuse) : undefined;
		if (reuse && snap && snap.status !== "disposed") {
			if (snap.status === "busy") throw new Error("复用会话上一轮仍在运行");
			sessionId = reuse;
		} else {
			const model = a.modelKey ? (parseModelKey(a.modelKey) ?? undefined) : undefined;
			const entry = await this.deps.host.createSession({ workspacePath, workspaceId, model });
			sessionId = entry.sessionId;
			if (a.reuseSession) this.reused.set(a.id, sessionId);
		}
		rec.sessionId = sessionId;
		this.flushRun(rec);

		// prompt + 等 settled(一次性订阅,超时兜底)
		let unsub = () => {};
		const settledP = new Promise<"settled">((resolve) => {
			unsub = this.deps.host.onSettled(sessionId, () => resolve("settled"));
		});
		const timeoutMs = a.timeoutMin * 60_000;
		try {
			await this.deps.host.prompt(sessionId, a.prompt);
		} finally {
			// prompt 受理失败也要退订(在 catch 统一收尾前)
		}
		const outcome = await Promise.race([
			settledP,
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
		]);
		unsub();

		if (outcome === "timeout") {
			await this.deps.host.abort(sessionId).catch(() => {});
			rec.status = "timeout";
			rec.error = `超时(${a.timeoutMin} 分钟),已中断会话`;
		} else {
			rec.status = "ok";
			const s = this.deps.host.getSnapshot(sessionId);
			const lastAssistant = [...(s?.messages ?? [])].reverse().find((m) => m.role === "assistant");
			if (lastAssistant?.text) rec.summary = lastAssistant.text.slice(-400);
		}
	}

	/* ---------------- Router 分派(P3) ---------------- */

	/** 常驻 Router 一次只能跑一轮 → 全部 Router 分派经此串行 */
	private routerChain: Promise<void> = Promise.resolve();

	private execViaRouter(a: Automation, rec: AutomationRun, workspaceId: string, workspacePath: string): Promise<boolean> {
		const next = this.routerChain.then(() => this.execViaRouterOnce(a, rec, workspaceId, workspacePath));
		this.routerChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * 经常驻 Router 执行:任务书 → Router spawn_worker 委派(必须落指定工作区)→ wait 收束 → 汇总。
	 * 返回 true = Router 已接管(run 已定型);false = 未接管,调用方回退直执。
	 */
	private async execViaRouterOnce(a: Automation, rec: AutomationRun, workspaceId: string, workspacePath: string): Promise<boolean> {
		const orch = this.deps.orchestrator!;
		let routerId: string;
		try {
			routerId = await orch.ensureRouter();
		} catch (err: any) {
			this.deps.host.log("warn", `常驻 Router 不可用,自动化回退直执:${err?.message ?? err}`);
			return false;
		}
		rec.sessionId = routerId;
		this.flushRun(rec);
		// 收集本轮分派的 Worker(按发起方 = 常驻 Router 过滤)
		const workerIds: string[] = [];
		const unsubW = orch.onWorkerUpdate((w) => {
			if (w.routerSessionId === routerId && !workerIds.includes(w.id)) workerIds.push(w.id);
		});
		let unsub = () => {};
		const timeoutMs = a.timeoutMin * 60_000;
		try {
			let settledFlag = false;
			const settledP = new Promise<"settled">((resolve) => {
				unsub = this.deps.host.onSettled(routerId, () => {
					settledFlag = true;
					resolve("settled");
				});
			});
			const brief = [
				`【自动化任务 · 需委派执行】目标工作区 workspaceId = "${workspaceId}"(路径:${workspacePath})。`,
				`任务书:`,
				a.prompt,
				``,
				`执行要求:`,
				`1. 用 spawn_worker 委派本任务,必须传 workspaceId:"${workspaceId}"(禁止省略或换其他值),任务书内容照传给 Worker。`,
				`2. 用 wait_workers 等待 Worker 完成。`,
				`3. 最后用一两句话汇总执行结果(成功/失败与关键信息)。`,
				`除上述编排工具外不要使用其他工具。`,
			].join("\n");
			// Router 可能上一轮尚未收束(busy):短候重试一次;prompt 有界(挂起 → 回退直执)
			const promptDeadlineMs = Math.min(timeoutMs, 120_000);
			const tryPrompt = async (): Promise<"ok" | "prompt-timeout"> => {
				const p = this.deps.host.prompt(routerId, brief);
				const r = await Promise.race([p, new Promise<"prompt-timeout">((resolve) => setTimeout(() => resolve("prompt-timeout"), promptDeadlineMs))]);
				return r === "prompt-timeout" ? "prompt-timeout" : "ok";
			};
			let prompted: "ok" | "prompt-timeout";
			try {
				prompted = await tryPrompt();
				if (prompted === "prompt-timeout") {
					// 重试一次(可能上一轮没收束)
					await new Promise((r) => setTimeout(r, 2000));
					prompted = await tryPrompt();
				}
			} catch (err: any) {
				this.deps.host.log("warn", `Router 任务书投递失败,自动化回退直执:${err?.message ?? err}`);
				unsub();
				return false;
			}
			if (prompted === "prompt-timeout") {
				this.deps.host.log("warn", "Router 任务书投递超时,自动化回退直执");
				await this.deps.host.abort(routerId).catch(() => {});
				unsub();
				return false;
			}

			// spawn 窗口:窗口内没有任何 Worker 出现 → Router 未按约束接管,回退直执
			const windowMs = this.deps.routerSpawnWindowMs ?? Math.min(120_000, Math.max(30_000, Math.floor(timeoutMs / 3)));
			const deadline = Date.now() + windowMs;
			while (Date.now() < deadline && !workerIds.length && !settledFlag) {
				await new Promise((r) => setTimeout(r, 150));
			}
			if (!workerIds.length) {
				if (!settledFlag) await this.deps.host.abort(routerId).catch(() => {});
				unsub();
				return false;
			}
			rec.workerIds = [...workerIds];
			this.flushRun(rec);

			const outcome = await Promise.race([
				settledP,
				new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
			]);
			unsub();
			if (outcome === "timeout") {
				await this.deps.host.abort(routerId).catch(() => {});
				rec.status = "timeout";
				rec.error = `超时(${a.timeoutMin} 分钟),已中断 Router 轮`;
				return true;
			}

			// Router 收束:等它派出的 Worker 全部收束(预算剩余,下限 5 分钟),汇总带 Worker 结果
			const startedAt = rec.startedAt;
			const remainSec = Math.max(300, Math.floor((timeoutMs - (Date.now() - startedAt)) / 1000));
			const done = await orch.waitWorkers(workerIds, remainSec);
			const bad = done.filter((w) => w.status !== "done").length;
			rec.status = "ok";
			const s = this.deps.host.getSnapshot(routerId);
			const lastAssistant = [...(s?.messages ?? [])].reverse().find((m) => m.role === "assistant");
			const routerText = lastAssistant?.text?.slice(-400) ?? "";
			rec.summary = [routerText, bad ? `⚠ ${bad}/${done.length} 个 Worker 未正常收束` : `Worker ${done.length}/${done.length} 正常收束`].filter(Boolean).join(" · ");
			return true;
		} catch (err: any) {
			this.deps.host.log("warn", `Router 分派异常,自动化回退直执:${err?.message ?? err}`);
			unsub();
			return false;
		} finally {
			unsubW();
		}
	}

	/* ---------------- 存储 ---------------- */

	private pushRun(autoId: string, rec: AutomationRun) {
		const list = this.store.runs[autoId] ?? [];
		list.unshift(rec);
		if (list.length > 50) list.length = 50;
		this.store.runs[autoId] = list;
		this.persist();
		this.emit({ type: "automation.run", run: rec });
	}

	private flushRun(rec: AutomationRun) {
		const list = this.store.runs[rec.automationId] ?? [];
		const i = list.findIndex((r) => r.id === rec.id);
		if (i >= 0) list[i] = { ...rec };
		this.persist();
		this.emit({ type: "automation.run", run: { ...rec } });
	}

	private persist() {
		try {
			writeFileSync(this.storePath, JSON.stringify(this.store, null, "\t"));
		} catch (e) {
			this.deps.host.log("warn", `automations.json 写入失败:${String(e)}`);
		}
	}
}
