/** AutomationManager 单测:cron/调度匹配、CRUD 校验持久化、运行引擎(假 host 全可控)、事件触发冷却、并发队列 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, AutomationRun, HostEvent } from "@jide/contracts";
import { AutomationManager, cronMatch, parseCron, scheduleDue, type AutomationDeps } from "./automation-manager";

const d = (y: number, mo: number, day: number, h: number, mi: number, weekday?: number) => {
	const dt = new Date(y, mo - 1, day, h, mi);
	if (weekday !== undefined) expect(dt.getDay()).toBe(weekday);
	return dt;
};

describe("cron / 调度匹配", () => {
	test("cronMatch:精确/通配/步进/区间/列表/dom-dow OR 语义/非法", () => {
		expect(cronMatch("30 9 * * *", d(2026, 11, 2, 9, 30))).toBe(true);
		expect(cronMatch("30 9 * * *", d(2026, 11, 2, 9, 31))).toBe(false);
		expect(cronMatch("*/15 * * * *", d(2026, 11, 2, 10, 45))).toBe(true);
		expect(cronMatch("*/15 * * * *", d(2026, 11, 2, 10, 50))).toBe(false);
		expect(cronMatch("0 9-17 * * *", d(2026, 11, 2, 12, 0))).toBe(true);
		expect(cronMatch("0 9-17 * * *", d(2026, 11, 2, 18, 0))).toBe(false);
		expect(cronMatch("0 9 * * 1,3,5", d(2026, 11, 2, 9, 0, 1))).toBe(true); // 周一
		expect(cronMatch("0 9 * * 1,3,5", d(2026, 11, 4, 9, 0, 3))).toBe(true); // 周三
		expect(cronMatch("0 9 * * 1,3,5", d(2026, 11, 3, 9, 0, 2))).toBe(false); // 周二
		// 日与周都受限 → OR(标准 cron)
		expect(cronMatch("0 0 13 * 5", d(2026, 11, 13, 0, 0, 5))).toBe(true); // 13 号且周五:两个都中
		expect(cronMatch("0 0 13 * 5", d(2026, 12, 13, 0, 0, 0))).toBe(true); // 13 号(周日)→ OR 命中
		expect(cronMatch("0 0 13 * 5", d(2026, 11, 6, 0, 0, 5))).toBe(true); // 周五(非 13 号)→ OR 命中
		expect(cronMatch("0 0 13 * 5", d(2026, 11, 5, 0, 0, 4))).toBe(false); // 都不中
		expect(parseCron("99 * * * *")).toBeNull();
		expect(parseCron("* * * *")).toBeNull();
		expect(parseCron("a * * * *")).toBeNull();
		expect(parseCron("*/0 * * * *")).toBeNull();
	});

	test("scheduleDue:daily / weekdays(周末不触发)", () => {
		expect(scheduleDue({ kind: "daily", time: "22:00" }, d(2026, 11, 1, 22, 0, 0))).toBe(true); // 周日
		expect(scheduleDue({ kind: "weekdays", time: "09:30" }, d(2026, 11, 2, 9, 30, 1))).toBe(true); // 周一
		expect(scheduleDue({ kind: "weekdays", time: "09:30" }, d(2026, 11, 1, 9, 30, 0))).toBe(false); // 周日
		expect(scheduleDue({ kind: "daily", time: "25:00" }, d(2026, 11, 1, 22, 0, 0))).toBe(false);
		expect(scheduleDue({ kind: "event", type: "test-failed" }, d(2026, 11, 1, 22, 0, 0))).toBe(false);
	});
});

/* ---------------- 假依赖 ---------------- */

function makeDeps(over?: Partial<AutomationDeps>) {
	const root = mkdtempSync(join(tmpdir(), "jide-auto-test-"));
	const sessions = new Map<string, { status: string; messages: Array<{ role: string; text: string }> }>();
	const settledCbs = new Map<string, Set<() => void>>();
	const calls = { createSession: 0, prompt: 0, runTests: 0, runChecks: 0, enqueueChecks: 0, worktree: 0 };
	const deps: AutomationDeps = {
		host: {
			async createSession(opts) {
				calls.createSession++;
				const id = `s-${calls.createSession}`;
				sessions.set(id, { status: "idle", messages: [{ role: "user", text: opts.workspacePath }] });
				return { sessionId: id };
			},
			async prompt(sessionId) {
				calls.prompt++;
				const s = sessions.get(sessionId)!;
				s.status = "busy";
				s.messages.push({ role: "assistant", text: `done-${sessionId}` });
			},
			async abort(sessionId) {
				sessions.get(sessionId)!.status = "aborted";
			},
			getSession(sessionId) {
				const s = sessions.get(sessionId);
				return s ? { status: s.status } : undefined;
			},
			getSnapshot(sessionId) {
				const s = sessions.get(sessionId);
				return s ? { messages: s.messages } : undefined;
			},
			onSettled(sessionId, cb) {
				const set = settledCbs.get(sessionId) ?? new Set();
				set.add(cb);
				settledCbs.set(sessionId, set);
				return () => set.delete(cb);
			},
			log() {},
		},
		workspaces: {
			async createWorktree() {
				calls.worktree++;
				return { ok: true, workspaceId: `p:wt-${calls.worktree}`, path: `C:/wt-${calls.worktree}` };
			},
			locate: (workspaceId) => ({ cwd: workspaceId ? "C:/proj" : null, projectId: "p" }),
		},
		verify: {
			scanTests: () => ["a.test.ts"],
			gitStatus: async () => ({ ok: true, changes: [{ path: "a.ts" }] }),
			mapTests: (changed, all) => all,
			async runTests() {
				calls.runTests++;
				return { ok: true, selected: 1, total: 1, results: [{ status: "pass" }] };
			},
			async runChecks() {
				calls.runChecks++;
				return { ok: true, results: [{ passed: true, title: "c1" }] };
			},
			enqueueChecks: () => {
				calls.enqueueChecks++;
			},
		},
		runtimeRoot: root,
		maxConcurrent: 2,
	};
	const merged = Object.assign(deps, over);
	const mgr = new AutomationManager(merged);
	const events: HostEvent[] = [];
	mgr.bindEmitter((e) => events.push(e));
	const settle = (sessionId: string) => {
		const s = sessions.get(sessionId);
		if (s) s.status = "idle"; // 镜像真实宿主:settled → idle
		settledCbs.get(sessionId)?.forEach((cb) => cb());
	};
	return { mgr, deps: merged, sessions, settledCbs, calls, events, root, settle };
}

const baseAutomation = (over: Partial<Automation> = {}): Automation => ({
	id: "",
	name: "夜间回归",
	enabled: true,
	trigger: { kind: "daily", time: "22:00" },
	prompt: "跑一遍全量回归并修复失败",
	modelKey: "",
	target: { kind: "workspace", workspaceId: "p:default" },
	reuseSession: false,
	autoVerify: true,
	timeoutMin: 1,
	createdAt: 0,
	...over,
});

const waitUntil = async (cond: () => boolean, ms = 3000) => {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
};

describe("AutomationManager(CRUD 与校验)", () => {
	test("save 新建(生成 id/createdAt)→ 更新(保留 id)→ 持久化往返;非法触发器拒绝", () => {
		const { mgr, root } = makeDeps();
		const created = mgr.save(baseAutomation());
		expect(created.id).toMatch(/^auto-/);
		expect(created.createdAt).toBeGreaterThan(0);
		const updated = mgr.save({ ...created, name: "改名" });
		expect(updated.id).toBe(created.id);
		const reloaded = new AutomationManager({ ...({} as any), ...(mgr as any).deps, runtimeRoot: root });
		expect(reloaded.list().automations.length).toBe(1);
		expect(reloaded.list().automations[0].name).toBe("改名");

		expect(() => mgr.save(baseAutomation({ name: " " }))).toThrow("名称");
		expect(() => mgr.save(baseAutomation({ prompt: "" }))).toThrow("prompt");
		expect(() => mgr.save(baseAutomation({ trigger: { kind: "cron", expr: "99 * * * *" } }))).toThrow("cron");
		expect(() => mgr.save(baseAutomation({ trigger: { kind: "daily", time: "25:99" } }))).toThrow("时间");
		expect(() => mgr.save(baseAutomation({ modelKey: "no-slash" }))).toThrow("模型 key");
		rmSync(root, { recursive: true, force: true });
	});

	test("delete 清任务清历史", () => {
		const { mgr } = makeDeps();
		const a = mgr.save(baseAutomation());
		mgr.delete(a.id);
		expect(mgr.list().automations.length).toBe(0);
		expect(mgr.list().runs[a.id]).toBeUndefined();
	});
});

describe("AutomationManager(运行引擎)", () => {
	test("完整一轮:排队→运行→settled→自动验证→历史落盘+事件流", async () => {
		const { mgr, calls, events, root, settle } = makeDeps();
		const a = mgr.save(baseAutomation());
		const rec = await mgr.run(a.id, "manual");
		// run() 返回时引擎可能已同步推进到 running(pump 即刻出队)
		expect(["queued", "running"]).toContain(rec.status);
		await waitUntil(() => calls.prompt === 1);
		settle("s-1");
		expect(await waitUntil(() => calls.runTests === 1 && calls.runChecks === 1 && calls.enqueueChecks === 1)).toBe(true);
		const runs = mgr.list().runs[a.id];
		expect(runs[0].status).toBe("ok");
		expect(runs[0].tests).toEqual({ selected: 1, total: 1, passed: 1, failed: 0 });
		expect(runs[0].checks).toEqual({ total: 1, passed: 1 });
		expect(runs[0].summary).toContain("done-");
		expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
		// 事件流:automation.run 至少 3 次(queued/running/终态)
		const runEvents = events.filter((e: any) => e.type === "automation.run");
		expect(runEvents.length).toBeGreaterThanOrEqual(3);
		expect(readFileSync(join(root, "automations.json"), "utf8")).toContain("ok");
		rmSync(root, { recursive: true, force: true });
	});

	test("repo 目标:每 run 新建 worktree;复用会话只建一次", async () => {
		const { mgr, calls, settle, root } = makeDeps();
		const a = mgr.save(
			baseAutomation({ target: { kind: "repo", repoId: "p" }, reuseSession: true, autoVerify: false, trigger: { kind: "event", type: "test-failed" } }),
		);
		const r1 = await mgr.run(a.id, "manual");
		await waitUntil(() => calls.prompt === 1);
		settle("s-1");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "ok");
		const r2 = await mgr.run(a.id, "manual");
		await waitUntil(() => calls.prompt === 2);
		settle("s-2");
		await waitUntil(() => mgr.list().runs[a.id][0].id === r2.id && mgr.list().runs[a.id][0].status === "ok");
		expect(calls.worktree).toBe(2); // 每 run 新 worktree
		expect(calls.createSession).toBe(1); // 会话复用
		rmSync(root, { recursive: true, force: true });
	});

	test("复用会话亡了自动重建", async () => {
		const { mgr, sessions, calls, settle, root } = makeDeps();
		const a = mgr.save(baseAutomation({ reuseSession: true, autoVerify: false }));
		await mgr.run(a.id, "manual");
		await waitUntil(() => calls.prompt === 1);
		settle("s-1");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "ok");
		sessions.delete("s-1"); // 会话亡
		await mgr.run(a.id, "manual");
		await waitUntil(() => calls.prompt === 2);
		settle("s-2");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "ok");
		expect(calls.createSession).toBe(2);
		rmSync(root, { recursive: true, force: true });
	});

	test("超时:到点 abort 被调,run 记 timeout", async () => {
		const { mgr, calls, root, sessions } = makeDeps({ timeoutMinFloor: 0.001 }); // timeoutMin=0.001 → ~60ms
		const a = mgr.save(baseAutomation({ timeoutMin: 0.001, autoVerify: false }));
		await mgr.run(a.id, "manual");
		expect(await waitUntil(() => mgr.list().runs[a.id][0].status === "timeout", 4000)).toBe(true);
		expect(mgr.list().runs[a.id][0].error).toContain("超时");
		expect(sessions.get("s-1")?.status).toBe("aborted");
		void calls;
		rmSync(root, { recursive: true, force: true });
	});

	test("每任务互斥:运行中第二轮立即拒绝;settle 后可再跑", async () => {
		const { mgr, calls, root, settle } = makeDeps();
		const a = mgr.save(baseAutomation({ autoVerify: false }));
		void mgr.run(a.id, "manual"); // 不 settle → running
		await waitUntil(() => calls.prompt === 1);
		await expect(mgr.run(a.id, "manual")).rejects.toThrow("仍在运行");
		settle("s-1");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "ok");
		await mgr.run(a.id, "manual"); // 现在可再跑
		await waitUntil(() => calls.prompt === 2);
		rmSync(root, { recursive: true, force: true });
	});

	test("全局并发上限 + 队列:cap=1 时第二个任务排队,先跑的 settle 后接续", async () => {
		const { mgr, calls, root, settle } = makeDeps({ maxConcurrent: 1 });
		const a1 = mgr.save(baseAutomation({ name: "t1", autoVerify: false }));
		const a2 = mgr.save(baseAutomation({ name: "t2", autoVerify: false }));
		void mgr.run(a1.id, "manual");
		await waitUntil(() => calls.prompt === 1);
		const rec2 = await mgr.run(a2.id, "manual");
		expect(rec2.status).toBe("queued");
		await new Promise((r) => setTimeout(r, 120));
		expect(calls.prompt).toBe(1); // cap=1:a2 在排队
		settle("s-1");
		await waitUntil(() => calls.prompt === 2);
		await waitUntil(() => mgr.list().runs[a2.id][0].status === "ok");
		rmSync(root, { recursive: true, force: true });
	});

	test("事件触发:目标匹配才跑,冷却期内不重复;checks 全过不触发", async () => {
		const { mgr, calls, settle, root } = makeDeps();
		(mgr as any).deps.eventCooldownMin = 0.01; // 0.6s 冷却,便于测二次触发
		const a = mgr.save(
			baseAutomation({ trigger: { kind: "event", type: "test-failed" }, target: { kind: "workspace", workspaceId: "p:default" }, autoVerify: false }),
		);
		const ev = (failed: number): HostEvent =>
			({ type: "test.progress", seq: 1, workspaceId: "p:default", phase: "done", failed, passed: 1, selected: 2, total: 2, done: 2 }) as any;
		mgr.handleHostEvent(ev(2));
		await waitUntil(() => calls.prompt === 1);
		settle("s-1");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "ok");
		// 冷却期内再来 → 不跑
		mgr.handleHostEvent(ev(2));
		expect(calls.prompt).toBe(1);
		// 冷却过后 → 再跑
		await new Promise((r) => setTimeout(r, 800));
		mgr.handleHostEvent(ev(2));
		await waitUntil(() => calls.prompt === 2);
		// 不匹配的工作区 → 不跑
		mgr.handleHostEvent({ ...ev(2), workspaceId: "other:w" } as any);
		await new Promise((r) => setTimeout(r, 100));
		expect(calls.prompt).toBe(2);
		// 全过 → 不触发
		await new Promise((r) => setTimeout(r, 800));
		mgr.handleHostEvent(ev(0));
		await new Promise((r) => setTimeout(r, 150));
		expect(calls.prompt).toBe(2);
		rmSync(root, { recursive: true, force: true });
	});

	test("调度 tick:daily 到点触发一次,同分钟去重", async () => {
		const { mgr, calls, root } = makeDeps();
		const now = new Date();
		const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
		const a = mgr.save(baseAutomation({ trigger: { kind: "daily", time: hhmm }, autoVerify: false }));
		(mgr as any).tick();
		(mgr as any).tick(); // 同分钟去重
		await waitUntil(() => calls.prompt === 1);
		await new Promise((r) => setTimeout(r, 100));
		expect(calls.prompt).toBe(1);
		rmSync(root, { recursive: true, force: true });
	});

	test("prompt 抛错 → run 记 failed", async () => {
		const { mgr, deps, root } = makeDeps();
		deps.host.prompt = async () => {
			throw new Error("No API key");
		};
		const a = mgr.save(baseAutomation({ autoVerify: false }));
		await mgr.run(a.id, "manual");
		await waitUntil(() => mgr.list().runs[a.id][0].status === "failed");
		expect(mgr.list().runs[a.id][0].error).toContain("No API key");
		rmSync(root, { recursive: true, force: true });
	});
});

/* ---------------- Router 分派(P3) ---------------- */

function makeOrchestrator() {
	const listeners = new Set<(w: { id: string; routerSessionId?: string; status: string }) => void>();
	const state = { ensureFails: false, workerStatus: "done" };
	let routerCount = 0;
	const orch = {
		async ensureRouter() {
			if (state.ensureFails) throw new Error("no router model");
			routerCount++;
			return `router-${routerCount}`;
		},
		onWorkerUpdate(cb: (w: { id: string; routerSessionId?: string; status: string }) => void) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		async waitWorkers(ids: string[]) {
			return ids.map((id) => ({ id, status: state.workerStatus }));
		},
	};
	const spawnWorker = (routerId: string, workerId = `w-${Math.random().toString(36).slice(2, 6)}`) => {
		for (const cb of [...listeners]) cb({ id: workerId, routerSessionId: routerId, status: "running" });
		return workerId;
	};
	return { orch, state, spawnWorker, routerCount: () => routerCount };
}

describe("AutomationManager(Router 分派,P3)", () => {
	test("save 归一化 dispatch:router 保留,其余归 direct", () => {
		const { mgr, root } = makeDeps();
		expect(mgr.save(baseAutomation({ dispatch: "router" })).dispatch).toBe("router");
		expect(mgr.save(baseAutomation({ dispatch: "bogus" as any })).dispatch).toBe("direct");
		expect(mgr.save(baseAutomation()).dispatch).toBe("direct"); // 缺省直执(存量兼容)
		rmSync(root, { recursive: true, force: true });
	});

	test("Router 分派成功:任务书给常驻 Router → spawn_worker → 收束汇总;记 dispatched=router + workerIds", async () => {
		const { orch, spawnWorker, routerCount } = makeOrchestrator();
		const { mgr, deps, calls, root, settle } = makeDeps({ orchestrator: orch, routerSpawnWindowMs: 3000 });
		const routerPrompts: string[] = [];
		const origPrompt = deps.host.prompt.bind(deps.host);
		deps.host.prompt = async (sessionId: string, text: string) => {
			if (sessionId.startsWith("router-")) {
				routerPrompts.push(text);
				setTimeout(() => spawnWorker(sessionId, "w-r1"), 30);
				setTimeout(() => settle(sessionId), 120);
				return;
			}
			return origPrompt(sessionId, text);
		};
		const a = mgr.save(baseAutomation({ dispatch: "router", autoVerify: false }));
		await mgr.run(a.id, "manual");
		expect(await waitUntil(() => mgr.list().runs[a.id][0].status === "ok", 8000)).toBe(true);
		const run = mgr.list().runs[a.id][0];
		expect(run.dispatched).toBe("router");
		expect(run.workerIds).toEqual(["w-r1"]);
		expect(run.sessionId).toMatch(/^router-/);
		expect(run.summary).toContain("Worker 1/1 正常收束");
		expect(routerPrompts[0]).toContain('workspaceId = "p:default"');
		expect(routerPrompts[0]).toContain("spawn_worker");
		expect(calls.createSession).toBe(0); // 未走直执
		expect(routerCount()).toBe(1);
		rmSync(root, { recursive: true, force: true });
	});

	test("spawn 窗口无 Worker → 回退直执(fallback),run 记 dispatched=fallback", async () => {
		const { orch } = makeOrchestrator();
		const { mgr, deps, calls, root, settle } = makeDeps({ orchestrator: orch, routerSpawnWindowMs: 200 });
		const origAbort = deps.host.abort.bind(deps.host);
		deps.host.abort = async (sessionId: string) => {
			if (!sessionId.startsWith("router-")) return origAbort(sessionId); // 假 abort 对未知会话会炸
		};
		const origPrompt = deps.host.prompt.bind(deps.host);
		deps.host.prompt = async (sessionId: string, text: string) => {
			if (sessionId.startsWith("router-")) return; // Router 收了任务书但始终不派 Worker
			return origPrompt(sessionId, text);
		};
		const a = mgr.save(baseAutomation({ dispatch: "router", autoVerify: false }));
		await mgr.run(a.id, "manual");
		await waitUntil(() => calls.prompt === 1); // 回退后的直执 prompt
		settle("s-1");
		expect(await waitUntil(() => mgr.list().runs[a.id][0].status === "ok", 8000)).toBe(true);
		const run = mgr.list().runs[a.id][0];
		expect(run.dispatched).toBe("fallback");
		expect(run.sessionId).toBe("s-1"); // 直执会话
		expect(run.workerIds).toBeUndefined();
		expect(run.summary).toContain("done-s-1");
		expect(calls.createSession).toBe(1);
		rmSync(root, { recursive: true, force: true });
	});

	test("Router 不可用(ensureRouter 抛)→ 直接回退直执", async () => {
		const { orch, state } = makeOrchestrator();
		state.ensureFails = true;
		const { mgr, root, settle } = makeDeps({ orchestrator: orch });
		const a = mgr.save(baseAutomation({ dispatch: "router", autoVerify: false }));
		await mgr.run(a.id, "manual");
		await waitUntil(() => mgr.list().runs[a.id][0].sessionId === "s-1");
		settle("s-1");
		expect(await waitUntil(() => mgr.list().runs[a.id][0].status === "ok", 8000)).toBe(true);
		const run = mgr.list().runs[a.id][0];
		expect(run.dispatched).toBe("fallback");
		expect(run.sessionId).toBe("s-1");
		rmSync(root, { recursive: true, force: true });
	});

	test("dispatch=direct:直执路径,不碰 Router", async () => {
		const { orch, routerCount } = makeOrchestrator();
		const { mgr, root, settle } = makeDeps({ orchestrator: orch });
		const a = mgr.save(baseAutomation({ dispatch: "direct", autoVerify: false }));
		await mgr.run(a.id, "manual");
		await waitUntil(() => mgr.list().runs[a.id][0].sessionId === "s-1");
		settle("s-1");
		expect(await waitUntil(() => mgr.list().runs[a.id][0].status === "ok", 8000)).toBe(true);
		const run = mgr.list().runs[a.id][0];
		expect(run.dispatched).toBe("direct");
		expect(run.sessionId).toBe("s-1");
		expect(routerCount()).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});
});
