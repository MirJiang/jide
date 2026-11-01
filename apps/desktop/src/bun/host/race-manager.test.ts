/** RaceManager 单测:开赛/打分/选优合入(经评审队列)/丢弃/取消/持久化 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RaceManager, type RaceDeps } from "./race-manager";
import type { WorkerRecord } from "./orchestrator";

const waitUntil = async (cond: () => boolean, ms = 3000) => {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) return false;
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
};

function makeDeps(opts: { scores?: number[]; workers?: number } = {}) {
	const workers = new Map<string, WorkerRecord>();
	const workerCbs = new Set<(rec: WorkerRecord) => void>();
	const removed: string[] = [];
	const calls = { worktree: 0, commit: 0, enqueueCommit: 0, decide: 0, stop: 0 };
	let workerN = 0;
	const deps: RaceDeps = {
		orchestrator: {
			spawnWorker(o: any) {
				workerN++;
				const rec: WorkerRecord = {
					id: `w-${workerN}`,
					sessionId: `s-${workerN}`,
					workspaceId: o.workspaceId,
					objective: o.objective,
					status: "running",
					startedAt: Date.now(),
				};
				workers.set(rec.id, rec);
				for (const cb of workerCbs) cb({ ...rec });
				return rec;
			},
			stopWorker: async (id: string) => {
				calls.stop++;
				const w = workers.get(id);
				if (w) {
					w.status = "aborted";
					for (const cb of workerCbs) cb({ ...w });
				}
			},
			onWorkerUpdate(cb: (rec: WorkerRecord) => void) {
				workerCbs.add(cb);
				return () => workerCbs.delete(cb);
			},
		} as any,
		workspaces: {
			locate: (workspaceId: string) => ({ cwd: workspaceId ? `C:/ws-${workspaceId}` : null, projectId: workspaceId ? "p" : null }),
			getWorkspace: () => ({ branch: "jide/race" }),
			async createWorktree(_p: string, name: string) {
				calls.worktree++;
				return { ok: true as const, workspaceId: `p:wt:${name}`, path: `C:/wt-${name}`, branch: `jide/${name}` };
			},
			async removeWorktree(_p: string, workspaceId: string) {
				removed.push(workspaceId);
				return { ok: true as const };
			},
		},
		review: {
			enqueueCommit: () => {
				calls.enqueueCommit++;
			},
			pendingCommitItem: (_w: string, sha: string) => ({ id: `rv-${sha}` }),
			decide: async () => {
				calls.decide++;
				return { ok: true as const, merged: { sha: "merge01", message: "merged" } };
			},
		},
		verify: {
			scanTests: () => ["a.test.ts"],
			gitStatus: async () => ({ ok: true, changes: [{ path: "a.ts" }] }),
			mapTests: (_c: string[], all: string[]) => all,
			// 按工作区名确定性判定:第 1 路(-1)pass,第 2 路(-2)fail
			async runTests(cwd: string) {
				const pass = cwd.includes("-1");
				return { ok: true, selected: 1, total: 1, results: [{ status: pass ? "pass" : "fail" }] };
			},
			async runChecks(cwd: string) {
				const pass = cwd.includes("-1");
				return { ok: true, results: [{ passed: pass, title: "c1" }] };
			},
		},
		runtimeRoot: mkdtempSync(join(tmpdir(), "jide-race-test-")),
	};
	const mgr = new RaceManager(deps);
	// commit 打分后调用:按分数序注入 sha
	mgr.setCommitFn(async () => {
		calls.commit++;
		return { ok: true as const, sha: `sha-${String(calls.commit).padStart(7, "0")}` };
	});
	mgr.startWatching(); // 建立订阅
	// 每次 worker running 事件后由测试驱动 settle:模拟 Worker 收束
	const finishWorker = (id: string, status: WorkerRecord["status"] = "done") => {
		const w = workers.get(id);
		if (!w) return;
		w.status = status;
		w.summary = `summary-${id}`;
		void (mgr as any).onWorkerUpdate({ id, status, summary: w.summary });
	};
	return { mgr, deps, workers, workerCbs, calls, removed, finishWorker, root: deps.runtimeRoot };
}

describe("RaceManager(P3 竞赛)", () => {
	test("开赛:N worktree + N worker;running 状态", async () => {
		const { mgr, calls } = makeDeps();
		const raceId = await mgr.start({ objective: "两种修法比一比", workspaceId: "p:default", variants: [{}, {}] });
		const race = mgr.get(raceId)!;
		expect(race.status).toBe("running");
		expect(race.entries.length).toBe(2);
		expect(calls.worktree).toBe(2);
		rmSync((mgr as any).deps.runtimeRoot, { recursive: true, force: true });
	});

	test("全部收束 → 打分 + commit + awaiting-review;选优 → 评审队列合并 + 全部 worktree 清理", async () => {
		const { mgr, calls, workers, removed, root, finishWorker } = makeDeps({ scores: [100, 0] });
		const raceId = await mgr.start({ objective: "x", workspaceId: "p:default", variants: [{}, {}] });
		const race = mgr.get(raceId)!;
		finishWorker(race.entries[0].workerId, "done");
		finishWorker(race.entries[1].workerId, "done");
		expect(await waitUntil(() => race.status === "awaiting-review")).toBe(true);
		// 打分:第一路 tests pass + checks pass = 100;第二路 fail = 0
		expect(race.entries[0].score).toBe(100);
		expect(race.entries[1].score).toBe(0);
		expect(race.entries[0].sha).toMatch(/^sha-/);
		expect(calls.commit).toBe(2); // 各自 commit

		const r = await mgr.resolve(raceId, race.entries[0].workerId, "第一路更稳");
		expect(r.mergedSha).toBe("merge01");
		expect(calls.enqueueCommit).toBe(1);
		expect(calls.decide).toBe(1);
		expect(race.status).toBe("resolved");
		expect(race.winnerEntryId).toBe(race.entries[0].workerId);
		expect(removed.length).toBe(2); // 胜者与落者 worktree 都清理
		expect(readFileSync(join(root, "races.json"), "utf8")).toContain("resolved");
	});

	test("discard:全部清理 + resolved/discarded", async () => {
		const { mgr, removed, root } = makeDeps();
		const raceId = await mgr.start({ objective: "x", workspaceId: "p:default", variants: [{}] });
		const race = mgr.get(raceId)!;
		expect(await waitUntil(() => race.entries[0].status === "running")).toBe(true);
		await mgr.discard(raceId, "方向错了");
		expect(race.status).toBe("resolved");
		expect(race.resolution).toBe("discarded");
		expect(removed.length).toBe(1);
		rmSync(root, { recursive: true, force: true });
	});

	test("cancel:中断运行中 worker + 清理", async () => {
		const { mgr, calls, removed, root } = makeDeps();
		const raceId = await mgr.start({ objective: "x", workspaceId: "p:default", variants: [{}, {}] });
		await mgr.cancel(raceId);
		expect(calls.stop).toBe(2);
		expect(removed.length).toBe(2);
		expect(mgr.get(raceId)!.status).toBe("cancelled");
		rmSync(root, { recursive: true, force: true });
	});

	test("重启恢复:running → cancelled(awaiting-review 保留)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jide-race-p-"));
		writeFileSync(join(dir, "races.json"), JSON.stringify({ races: [
			{ id: "race-a", objective: "x", entries: [], status: "running", createdAt: 1 },
			{ id: "race-b", objective: "y", entries: [{ workerId: "w1", workspaceId: "p:wt:a", branch: "b", modelKey: "", status: "done", score: 90, sha: "sha-1" }], status: "awaiting-review", createdAt: 2 },
		] }));
		const { orchestrator } = makeDeps();
		const mgr = new RaceManager({ ...(mgrDepsStub as any), orchestrator, runtimeRoot: dir });
		expect(mgr.get("race-a")!.status).toBe("cancelled");
		expect(mgr.get("race-b")!.status).toBe("awaiting-review");
		rmSync(dir, { recursive: true, force: true });
	});

	test("超 4 路拒绝;非法模型 key 拒绝", async () => {
		const { mgr } = makeDeps();
		await expect(mgr.start({ objective: "x", workspaceId: "p:default", variants: [{}, {}, {}, {}, {}] })).rejects.toThrow("最多 4 路");
		await expect(mgr.start({ objective: "x", workspaceId: "p:default", variants: [{ modelKey: "bad" }] })).rejects.toThrow("模型 key");
	});
});

import { writeFileSync } from "node:fs";
const mgrDepsStub = {};
