/** TaskManager 单测:聊天轮归组/收口、automation 卡、race 卡、清理、重启恢复 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostEventInput } from "@jide/contracts";
import { TaskManager } from "./task-manager";

function makeMgr() {
	const root = mkdtempSync(join(tmpdir(), "jide-task-test-"));
	const events: HostEventInput[] = [];
	const workers = new Map<string, { status: string; verified?: string }>();
	const finalized: string[] = [];
	const raceState = { status: "running" };
	const mgr = new TaskManager({
		runtimeRoot: root,
		getAutomation: (id) => ({ name: `夜间回归(${id})` }),
		getRace: (id) => ({
			id,
			objective: "比一比",
			status: raceState.status,
			entries: [
				{ workerId: "w-1", status: "done", score: 100 },
				{ workerId: "w-2", status: "done", score: 40 },
			],
			workspaceId: "p:default",
		}),
		onFinalize: (t) => finalized.push(t.id),
	});
	mgr.bindEmitter((e) => events.push(e));
	mgr.bindWorkerLookup((id) => workers.get(id));
	const settle = (sessionId: string) => mgr.handleHostEvent({ type: "agent.settled", seq: 1, sessionId } as any);
	return { mgr, events, workers, finalized, root, settle, raceState };
}

describe("TaskManager(P3.3 任务卡)", () => {
	test("聊天轮归组:同发起方未收口附加为一张卡;settle 终态;之后新 spawn 开新卡", () => {
		const { mgr, workers, finalized, settle } = makeMgr();
		const t1 = mgr.attachWorker({ routerSessionId: "chat-1", workerId: "w-1", objective: "修 A", workspaceId: "p:default" });
		const t1b = mgr.attachWorker({ routerSessionId: "chat-1", workerId: "w-2", objective: "修 B" });
		expect(t1b.id).toBe(t1.id); // 同轮归组
		expect(t1.workerIds).toEqual(["w-1", "w-2"]);
		// Worker 全收束但会话未 settle → 保持 running(轮未收口,Router 可能在汇总/续派)
		workers.set("w-1", { status: "done" });
		workers.set("w-2", { status: "done" });
		mgr.onWorkerUpdate({ id: "w-1", status: "done", summary: "ok-1" });
		expect(mgr.get(t1.id)!.status).toBe("running");
		expect(mgr.get(t1.id)!.summary).toContain("ok-1");
		// settle → 终态 done,一次性回调
		settle("chat-1");
		expect(mgr.get(t1.id)!.status).toBe("done");
		expect(finalized).toEqual([t1.id]);
		// 新一轮(旧卡已终态)→ 新卡
		const t2 = mgr.attachWorker({ routerSessionId: "chat-1", workerId: "w-3", objective: "再修 C" });
		expect(t2.id).not.toBe(t1.id);
	});

	test("全失败 Worker → failed 带错误摘要;投机红 → failed;settle 回调仅一次", () => {
		const { mgr, workers, finalized, settle } = makeMgr();
		const t = mgr.attachWorker({ routerSessionId: "chat-2", workerId: "w-1", objective: "x" });
		workers.set("w-1", { status: "failed" });
		mgr.onWorkerUpdate({ id: "w-1", status: "failed", error: "boom" });
		settle("chat-2");
		expect(mgr.get(t.id)!.status).toBe("failed");
		expect(mgr.get(t.id)!.summary).toContain("boom");
		settle("chat-2"); // 重复 settle:已终态不再触发
		expect(finalized).toEqual([t.id]);

		const m2 = makeMgr();
		const t2 = m2.mgr.attachWorker({ routerSessionId: "chat-3", workerId: "w-1", objective: "spec" });
		m2.workers.set("w-1", { status: "done", verified: "red" });
		m2.mgr.onWorkerUpdate({ id: "w-1", status: "done" });
		m2.settle("chat-3");
		expect(m2.mgr.get(t2.id)!.status).toBe("failed"); // 投机红 = 丢弃
	});

	test("automation.run:queued 建卡 → ok+运行中 Worker 保持 running → 收束 done;failed 直达", () => {
		const { mgr, workers } = makeMgr();
		mgr.handleHostEvent({ type: "automation.run", seq: 1, run: { id: "run-1", automationId: "auto-1", startedAt: 1, status: "queued", trigger: "manual" } } as any);
		const t = mgr.list().find((x) => x.runId === "run-1")!;
		expect(t.source).toBe("automation");
		expect(t.title).toBe("自动化:夜间回归(auto-1)");
		// Router 分派:run 带 sessionId/workerIds → 卡归组信息齐备,Worker 未收束 → running
		mgr.handleHostEvent({
			type: "automation.run",
			seq: 2,
			run: { id: "run-1", automationId: "auto-1", startedAt: 1, status: "ok", trigger: "manual", sessionId: "router-1", workerIds: ["w-9"], summary: "分派完成" },
		} as any);
		expect(t.routerSessionId).toBe("router-1");
		expect(t.workerIds).toEqual(["w-9"]);
		expect(t.status).toBe("running");
		// Worker 收束 → done
		workers.set("w-9", { status: "done" });
		mgr.onWorkerUpdate({ id: "w-9", status: "done", summary: "wok" });
		expect(t.status).toBe("done");
		expect(t.summary).toContain("wok");
		// 失败 run → failed(即时,无 Worker)
		mgr.handleHostEvent({ type: "automation.run", seq: 3, run: { id: "run-2", automationId: "auto-1", startedAt: 1, status: "failed", trigger: "schedule", error: "x" } } as any);
		const t2 = mgr.list().find((x) => x.runId === "run-2")!;
		expect(t2.status).toBe("failed");
	});

	test("race.updated:running → awaiting-review → resolved;resolve 后卡 done 带最高分摘要", () => {
		const { mgr, raceState } = makeMgr();
		const t = mgr.beginRace({ raceId: "race-1", objective: "比一比", workspaceId: "p:default", workerIds: ["w-1", "w-2"] });
		expect(t.source).toBe("race");
		expect(t.status).toBe("running");
		raceState.status = "awaiting-review";
		mgr.handleHostEvent({ type: "race.updated", seq: 1, raceId: "race-1" } as any);
		expect(t.status).toBe("awaiting-review");
		expect(t.summary).toContain("100"); // 最高分摘要
		raceState.status = "resolved";
		mgr.handleHostEvent({ type: "race.updated", seq: 2, raceId: "race-1" } as any);
		expect(t.status).toBe("done");
	});

	test("重启恢复:open 卡 → failed(daemon 中断);终态保留;dismiss 终态可清 open 拒", () => {
		const { mgr, root, settle, events } = makeMgr();
		const t1 = mgr.attachWorker({ routerSessionId: "chat-9", workerId: "w-1", objective: "会中断的活" });
		const t2 = mgr.attachWorker({ routerSessionId: "chat-8", workerId: "w-2", objective: "已完成的活" });
		settle("chat-8"); // w-2 无记录 → finalize 兜底 done
		expect(mgr.get(t2.id)!.status).toBe("done");
		expect(mgr.dismiss(t1.id).ok).toBe(false); // running 拒

		const mgr2 = new TaskManager({ runtimeRoot: root });
		expect(mgr2.list().find((x) => x.id === t1.id)!.status).toBe("failed");
		expect(mgr2.list().find((x) => x.id === t1.id)!.summary).toContain("daemon 重启");
		expect(mgr2.list().find((x) => x.id === t2.id)!.status).toBe("done");

		expect(mgr2.dismiss(t1.id).ok).toBe(true); // 恢复成终态后可清
		expect(mgr2.get(t1.id)).toBeUndefined();
		expect(events.filter((e) => e.type === "task.updated").length).toBeGreaterThanOrEqual(3);
		rmSync(root, { recursive: true, force: true });
	});
});
