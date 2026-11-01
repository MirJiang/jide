/** 编排扩展 + 事件持久化 + autostart 单测 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAutostart } from "./autostart";
import { EventStore } from "./event-store";

/* ---------------- jide-orchestrator 扩展 ---------------- */

async function loadTools(env: Record<string, string>, cacheKey: string) {
	const saved = { ...process.env };
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	try {
		const mod = await import(`./extensions/jide-orchestrator?case=${cacheKey}`);
		const registered: any[] = [];
		mod.default({ registerTool: (t: any) => registered.push(t) });
		return registered;
	} finally {
		process.env = saved;
	}
}

describe("jide-orchestrator 扩展(委派工具)", () => {
	test("JIDE_ORCH=1:注册 6 个委派工具,execute 透传 __router", async () => {
		const registered = await loadTools(
			{ JIDE_ORCH: "1", JIDE_BRIDGE_URL: "http://127.0.0.1:1", JIDE_BRIDGE_TOKEN: "t", JIDE_WORKSPACE_ID: "p:w" },
			"on",
		);
		expect(registered.map((t) => t.name)).toEqual([
			"spawn_worker",
			"wait_workers",
			"worker_status",
			"send_to_worker",
			"stop_worker",
			"start_race",
		]);
		let seen: any = null;
		const orig = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			seen = { url: String(_input), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], details: undefined }), { status: 200 });
		}) as any;
		try {
			const out = await registered[0].execute("c", { objective: "干活的" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "router-session-1" },
			});
			expect(out.content[0].text).toBe("ok");
			expect(seen.url).toBe("http://127.0.0.1:1/tool/spawn_worker");
			expect(seen.body.params.__router).toBe("router-session-1");
			expect(seen.body.workspaceId).toBe("p:w");
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("无 JIDE_ORCH:零注册(非编排会话零存在感)", async () => {
		const registered = await loadTools({}, "off");
		expect(registered.length).toBe(0);
	});
});

/* ---------------- EventStore ---------------- */

describe("EventStore(事件落盘)", () => {
	test("append/load 往返;坏行跳过;轮转 .old", () => {
		const dir = mkdtempSync(join(tmpdir(), "jide-evstore-"));
		const es = new EventStore(dir, { maxBytes: 2000, maxLoad: 100 });
		for (let i = 1; i <= 8; i++) es.append({ type: "host.log", seq: i, level: "info", message: `事件 ${i}` } as any);
		expect(es.load().length).toBe(8);
		// 第二批足够长 → 恰好触发一次轮转(.old = 前段,当前 = 后段,合计不丢)
		for (let i = 9; i <= 20; i++)
			es.append({ type: "host.log", seq: i, level: "info", message: `后续事件 ${i} —— ${"padding".repeat(30)}` } as any);
		const loaded2 = es.load();
		expect(loaded2.length).toBe(20);
		expect(existsSync(join(dir, "events.jsonl.old"))).toBe(true);
		// 坏行容错
		writeFileSync(join(dir, "events.jsonl"), "{bad json\n", "utf8");
		const es2 = new EventStore(dir, {});
		expect(es2.load().length).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true, force: true });
	});
});

/* ---------------- autostart ---------------- */

describe("autostart(注册表 Run 键)", () => {
	test("启用:reg add 指向 launcher;停用:reg delete;失败透传", () => {
		const cmds: string[][] = [];
		const runner = (cmd: string[]) => {
			cmds.push(cmd);
			return { status: 0 };
		};
		const appDir = join("X:", "app", "Resources", "app");
		const r1 = applyAutostart(true, appDir, runner);
		expect(r1.ok).toBe(true);
		expect(cmds[0][0]).toBe("reg");
		expect(cmds[0][1]).toBe("add");
		expect(cmds[0].at(-2)).toBe('"X:\\app\\bin\\launcher.exe"');
		const r2 = applyAutostart(false, appDir, runner);
		expect(r2.ok).toBe(true);
		expect(cmds[1]).toEqual(["reg", "delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "JIDE", "/f"]);
		const r3 = applyAutostart(true, appDir, () => ({ status: 1 }));
		expect(r3.ok).toBe(false);
	});
});

/* ---------------- 精判钩子(DevLogPump × 模型精判) ---------------- */

import { DevLogPump } from "./dev-log-pump";

describe("DevLogPump × 模型精判(两级过滤)", () => {
	const FAST = { debounceMs: 20, minIntervalMs: 0, maxPushesPerTurn: 5 };
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	function pumpHost(steered: string[]) {
		return {
			logs: [] as string[],
			log(_l: any, m: string) {
				this.logs.push(m);
			},
			async steerBusyForWorkspace(_w: string, text: string) {
				steered.push(text);
				return 1;
			},
			getSession: () => ({ workspaceId: "p:w1" }),
			hasSessionForWorkspace: () => true,
			hasBusySessionForWorkspace: () => true,
		};
	}
	const ERR = "Error: EADDRINUSE";

	test("精判 false → 不插队,降级日志;true → 插队", async () => {
		const steered: string[] = [];
		const host = pumpHost(steered);
		const judgeVerdicts = [false, true];
		const pump = new DevLogPump(host as any, { ...FAST, judge: async () => judgeVerdicts.shift() ?? null });
		pump.onLine("p:w1", ERR);
		await sleep(120);
		expect(steered.length).toBe(0);
		expect(host.logs.some((l) => l.includes("暂不值得打断"))).toBe(true);
		pump.onLine("p:w1", ERR);
		await sleep(120);
		expect(steered.length).toBe(1);
		expect(steered[0]).toContain("宿主推送");
		pump.dispose();
	});

	test("精判不可用(null)→ 回退直推", async () => {
		const steered: string[] = [];
		const host = pumpHost(steered);
		const pump = new DevLogPump(host as any, { ...FAST, judge: async () => null });
		pump.onLine("p:w1", ERR);
		await sleep(120);
		expect(steered.length).toBe(1);
		pump.dispose();
	});

	test("无 busy 会话 → 不调用精判,直推路径照旧", async () => {
		const steered: string[] = [];
		const host = pumpHost(steered);
		host.hasBusySessionForWorkspace = () => false;
		let judgeCalled = 0;
		const pump = new DevLogPump(host as any, { ...FAST, judge: async () => (judgeCalled++, null) });
		pump.onLine("p:w1", ERR);
		await sleep(120);
		expect(judgeCalled).toBe(0);
		expect(steered.length).toBe(1);
		pump.dispose();
	});
});

/* ---------------- 投机执行(OrchestratorManager × verify/commit) ---------------- */

import { OrchestratorManager, type OrchestratorDeps } from "./orchestrator";

describe("投机执行(隔离 worktree → 验证 → 提交/丢弃)", () => {
	function specDeps(verifyGreen: boolean) {
		const sessions = new Map<string, { status: string; messages: Array<{ role: string; text: string }> }>();
		const settledCbs = new Map<string, Set<() => void>>();
		const calls = { createSession: 0, prompt: 0, commit: 0, enqueueCommit: 0, worktree: 0 };
		const deps: OrchestratorDeps = {
			host: {
				async createSession() {
					calls.createSession++;
					const id = `s-${calls.createSession}`;
					sessions.set(id, { status: "idle", messages: [{ role: "assistant", text: "fixed" }] });
					return { sessionId: id };
				},
				async prompt(sessionId) {
					calls.prompt++;
					sessions.get(sessionId)!.status = "busy";
				},
				async steerSession() {},
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
				locate: (workspaceId: string) => ({
					cwd: workspaceId.includes("wt") ? `C:/wt-${workspaceId}` : "C:/proj",
					projectId: "p",
				}),
				getWorkspace: (_p, _w) => ({ branch: "jide/spec" }),
				async createWorktree() {
					calls.worktree++;
					return { ok: true, workspaceId: `p:wt:${calls.worktree}`, path: `C:/wt-${calls.worktree}` };
				},
			},
			verify: {
				scanTests: () => ["a.test.ts"],
				gitStatus: async () => ({ ok: true, changes: [{ path: "a.ts" }] }),
				mapTests: (_c, all) => all,
				async runTests() {
					return { ok: true, selected: 1, total: 1, results: [{ status: verifyGreen ? "pass" : "fail" }] };
				},
				async runChecks() {
					return { ok: true, results: [{ passed: verifyGreen, title: "c1" }] };
				},
				enqueueChecks: () => {},
				async commitAll() {
					calls.commit++;
					return { ok: true, sha: "abc1234567" };
				},
				enqueueCommit: () => {
					calls.enqueueCommit++;
				},
			},
			maxConcurrent: 2,
		};
		const mgr = new OrchestratorManager(deps);
		const settle = (sessionId: string) => {
			const s = sessions.get(sessionId);
			if (s) s.status = "idle";
			settledCbs.get(sessionId)?.forEach((cb) => cb());
		};
		return { mgr, calls, settle };
	}

	const waitUntil = async (cond: () => boolean, ms = 3000) => {
		const t0 = Date.now();
		while (!cond()) {
			if (Date.now() - t0 > ms) return false;
			await new Promise((r) => setTimeout(r, 20));
		}
		return true;
	};

	test("验证绿 → worktree 隔离 + commitAll + enqueueCommit(评审队列)", async () => {
		const { mgr, calls, settle } = specDeps(true);
		mgr.noteRouter("r1");
		const w = mgr.spawnWorker({ objective: "修浮点 bug", workspaceId: "p:default", speculative: true });
		await waitUntil(() => calls.prompt === 1);
		settle(w.sessionId);
		expect(await waitUntil(() => mgr.get(w.id)!.status === "done")).toBe(true);
		expect(calls.worktree).toBe(1); // 隔离 worktree
		expect(mgr.get(w.id)!.verified).toBe("green");
		expect(calls.commit).toBe(1);
		expect(calls.enqueueCommit).toBe(1);
		expect(mgr.get(w.id)!.summary).toContain("待评审");
	});

	test("验证红 → 不提交不进评审(丢弃,原样保留)", async () => {
		const { mgr, calls, settle } = specDeps(false);
		mgr.noteRouter("r1");
		const w = mgr.spawnWorker({ objective: "修浮点 bug", workspaceId: "p:default", speculative: true });
		await waitUntil(() => calls.prompt === 1);
		settle(w.sessionId);
		expect(await waitUntil(() => mgr.get(w.id)!.status === "done")).toBe(true);
		expect(mgr.get(w.id)!.verified).toBe("red");
		expect(calls.commit).toBe(0);
		expect(calls.enqueueCommit).toBe(0);
	});
});
