/** OrchestratorManager 单测:Worker 池/完成回喂(steer vs prompt)/wait_workers/Watchdog/循环检测 */

import { describe, expect, test } from "bun:test";
import type { HostEvent } from "@jide/contracts";
import { OrchestratorManager, type OrchestratorDeps } from "./orchestrator";

function makeDeps(over?: Partial<OrchestratorDeps>) {
	const sessions = new Map<string, { status: string; messages: Array<{ role: string; text: string }> }>();
	const settledCbs = new Map<string, Set<() => void>>();
	const calls = { createSession: 0, prompt: 0, steer: 0, abort: 0 };
	const deps: OrchestratorDeps = {
		host: {
			async createSession() {
				calls.createSession++;
				const id = `s-${calls.createSession}`;
				sessions.set(id, { status: "idle", messages: [] });
				return { sessionId: id };
			},
			async prompt(sessionId, text) {
				calls.prompt++;
				const s = sessions.get(sessionId)!;
				if (text.includes("【Worker")) return; // 回喂
				s.status = "busy";
				s.messages.push({ role: "assistant", text: `done(${sessionId})` });
			},
			async steerSession(sessionId) {
				calls.steer++;
				if (!sessions.has(sessionId)) throw new Error("pi 拒绝:idle 会话不能 steer");
			},
			async abort(sessionId) {
				calls.abort++;
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
		workspaces: { locate: () => ({ cwd: "C:/proj", projectId: "p" }) },
		maxConcurrent: 2,
		workerTimeoutMin: 30,
	};
	const merged = Object.assign(deps, over);
	const mgr = new OrchestratorManager(merged);
	const events: HostEvent[] = [];
	mgr.bindEmitter((e) => events.push(e));
	const settle = (sessionId: string) => {
		const s = sessions.get(sessionId);
		if (s) s.status = "idle";
		settledCbs.get(sessionId)?.forEach((cb) => cb());
	};
	return { mgr, deps: merged, sessions, calls, events, settle };
}

const waitUntil = async (cond: () => boolean, ms = 3000) => {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
};

describe("OrchestratorManager(Worker 池与委派)", () => {
	test("spawn → 排队/并发上限 → 完成 → 摘要 + 回喂 Router(空闲 → prompt)", async () => {
		const { mgr, calls, sessions, settle } = makeDeps({ maxConcurrent: 1 });
		mgr.noteRouter("router-1");
		sessions.set("router-1", { status: "idle", messages: [] });
		const w1 = mgr.spawnWorker({ objective: "任务 A", workspaceId: "p:default" });
		const w2 = mgr.spawnWorker({ objective: "任务 B", workspaceId: "p:default" });
		expect(["queued", "running"]).toContain(w1.status);
		await waitUntil(() => calls.createSession === 1);
		expect(mgr.get(w2.id)!.status).toBe("queued"); // cap=1:B 排队
		settle("s-1");
		expect(await waitUntil(() => mgr.get(w2.id)!.status === "running")).toBe(true);
		settle("s-2");
		expect(await waitUntil(() => mgr.get(w1.id)!.status === "done" && mgr.get(w2.id)!.status === "done")).toBe(true);
		expect(mgr.get(w1.id)!.summary).toContain("done(s-1)");
		expect(calls.prompt).toBeGreaterThanOrEqual(4); // 2 worker prompt + 2 回喂 prompt(空闲)
	});

	test("Router 忙碌 → 回喂走 steer", async () => {
		const { mgr, calls, sessions, settle } = makeDeps();
		mgr.noteRouter("router-1");
		sessions.set("router-1", { status: "busy", messages: [] });
		const w = mgr.spawnWorker({ objective: "x", workspaceId: "p:default" });
		await waitUntil(() => calls.prompt === 1);
		settle("s-1");
		await waitUntil(() => mgr.get(w.id)!.status === "done");
		expect(calls.steer).toBe(1); // 忙 → steer
	});

	test("wait_workers:同步等到全部收束并返回快照", async () => {
		const { mgr, settle } = makeDeps();
		mgr.noteRouter("router-1");
		const w = mgr.spawnWorker({ objective: "x", workspaceId: "p:default" });
		const p = mgr.waitWorkers([w.id], 5);
		await waitUntil(() => mgr.list().length === 1 && mgr.list()[0].status === "running");
		settle("s-1");
		const out = await p;
		expect(out[0].status).toBe("done");
	});

	test("Watchdog 超时:abort + 状态 timeout + 回喂", async () => {
		const { mgr, calls } = makeDeps({ workerTimeoutMin: 0.001 });
		mgr.noteRouter("router-1");
		mgr.startWatchdog();
		const w = mgr.spawnWorker({ objective: "永不收敛", workspaceId: "p:default", timeoutMin: 0.001 });
		expect(await waitUntil(() => mgr.get(w.id)!.status === "timeout", 5000)).toBe(true);
		expect(calls.abort).toBe(1);
		mgr.dispose();
	});

	test("循环检测:连续同名词工具调用 → 一次 steer 提醒", async () => {
		const { mgr, calls } = makeDeps();
		mgr.noteRouter("router-1");
		const w = mgr.spawnWorker({ objective: "x", workspaceId: "p:default" });
		await waitUntil(() => mgr.list()[0].status === "running");
		const sid = mgr.get(w.id)!.sessionId;
		for (let i = 0; i < 4; i++) {
			mgr.handleHostEvent({ type: "agent.tool", phase: "start", toolName: "read", sessionId: sid, seq: i } as any);
		}
		expect(calls.steer).toBe(1);
		mgr.handleHostEvent({ type: "agent.tool", phase: "start", toolName: "read", sessionId: sid, seq: 9 } as any);
		expect(calls.steer).toBe(1); // 只提醒一次
		// 非 Worker 会话不触发
		mgr.handleHostEvent({ type: "agent.tool", phase: "start", toolName: "read", sessionId: "other", seq: 10 } as any);
		expect(calls.steer).toBe(1);
	});

	test("send_to_worker:忙碌拒绝;空闲可追加并重新等待", async () => {
		const { mgr, calls, settle } = makeDeps();
		mgr.noteRouter("router-1");
		const w = mgr.spawnWorker({ objective: "x", workspaceId: "p:default" });
		await waitUntil(() => calls.prompt === 1);
		await expect(mgr.sendToWorker(w.id, "继续")).rejects.toThrow("仍在运行");
		settle("s-1");
		await waitUntil(() => mgr.get(w.id)!.status === "done");
		await mgr.sendToWorker(w.id, "再干一轮");
		await waitUntil(() => mgr.get(w.id)!.status === "done");
		expect(calls.prompt).toBe(3); // worker1 + 回喂 + 追加
	});

	test("stop_worker:abort + aborted 状态", async () => {
		const { mgr, calls } = makeDeps();
		mgr.noteRouter("router-1");
		const w = mgr.spawnWorker({ objective: "x", workspaceId: "p:default" });
		await waitUntil(() => calls.prompt === 1);
		await mgr.stopWorker(w.id);
		expect(mgr.get(w.id)!.status).toBe("aborted");
	});
});
