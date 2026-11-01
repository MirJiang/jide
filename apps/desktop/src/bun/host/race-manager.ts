/**
 * RaceManager — P3 竞赛域:fan-out 一拖 N 对比选优(Orca 招牌的 JIDE 形态)
 *
 * 开赛:同一任务书播 N 个隔离 worktree(可逐个指定模型),各由一个 Worker 执行;
 * 收束:全部终态且全部打分后 → awaiting-review(自动打分:测试与检查项通过率各半,
 *       0-100;Q2 判优 = 自动打分 + 人工终审),各 entry commit 留档;
 * 选优:胜者分支经评审队列合并逻辑合入主线(复用 review.decide 的 ff/rebase 处理),
 *       全部 entry worktree + 分支清理;可整体丢弃;运行中可取消。
 * 持久化:races.json(daemon 重启后 running 竞赛标记 cancelled,awaiting-review 保留可比)。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HostEvent, Race, RaceEntry } from "@jide/contracts";
import { parseModelKey } from "@jide/contracts";
import type { EmitFn } from "./agent-host";
import type { OrchestratorManager } from "./orchestrator";

export interface RaceDeps {
	orchestrator: OrchestratorManager;
	workspaces: {
		locate(workspaceId: string): { cwd: string | null; projectId: string | null };
		getWorkspace(projectId: string, workspaceId: string): { branch?: string } | undefined;
		createWorktree(repoId: string, name: string): Promise<{ ok: true; workspaceId: string; path: string; branch?: string } | { ok: false; error: string }>;
		removeWorktree(projectId: string, workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }>;
	};
	review: {
		enqueueCommit(workspaceId: string, branch: string, sha: string, message: string): void;
		/** 按 sha 找 pending 的 commit 评审项(竞赛收口入队后定位) */
		pendingCommitItem(workspaceId: string, sha: string): { id: string } | undefined;
		/** 复用评审队列合并逻辑(ff-only / rebase+ff) */
		decide(id: string, decision: "approve" | "ask" | "ignore"): Promise<{ ok: true; merged?: { sha: string; message: string } } | { ok: false; error: string }>;
	};
	verify: {
		scanTests(cwd: string): string[];
		gitStatus(workspaceId: string): Promise<{ ok: true; changes: Array<{ path: string }> } | { ok: false; error: string }>;
		mapTests(changed: string[], all: string[]): string[];
		runTests(cwd: string, files: string[], total: number): Promise<{ ok: boolean; selected: number; total: number; results: Array<{ status: string }> }>;
		runChecks(workspaceId: string): Promise<{ ok: boolean; results: Array<{ passed: boolean; title: string }> }>;
	};
	runtimeRoot: string;
}

export class RaceManager {
	private races: Race[] = [];
	private storePath: string;
	private emit: EmitFn = () => {};
	private unsubWorker?: () => void;
	private commitFn: (workspaceId: string, message: string) => Promise<{ ok: true; sha: string } | { ok: false; error: string }> = async () => ({
		ok: false as const,
		error: "commitFn 未注入",
	});

	constructor(private deps: RaceDeps) {
		this.storePath = join(deps.runtimeRoot, "races.json");
		if (existsSync(this.storePath)) {
			try {
				const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
				if (Array.isArray(raw?.races)) {
					this.races = raw.races;
					// daemon 重启:running 竞赛 Worker 已亡 → 标记取消
					for (const r of this.races) {
						if (r.status === "running") {
							r.status = "cancelled";
							r.note = "daemon 重启,运行中断";
						}
					}
				}
			} catch {
				/* 损坏回落 */
			}
		}
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	/** 订阅 Worker 状态(每个终态 entry 打分/提交;全部终态且已打分 → awaiting-review) */
	startWatching() {
		this.unsubWorker?.();
		this.unsubWorker = this.deps.orchestrator.onWorkerUpdate((rec) => void this.onWorkerUpdate(rec));
	}

	dispose() {
		this.unsubWorker?.();
	}

	list(): Race[] {
		return [...this.races].sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): Race | undefined {
		return this.races.find((r) => r.id === id);
	}

	/** 注入 commit 实现(daemon:workspaces.commitAll) */
	setCommitFn(fn: (workspaceId: string, message: string) => Promise<{ ok: true; sha: string } | { ok: false; error: string }>) {
		this.commitFn = fn;
	}

	/** 开赛;返回 raceId(失败抛错,调用方转 ok:false) */
	async start(opts: {
		objective: string;
		workspaceId: string;
		variants?: Array<{ modelKey?: string }>;
		timeoutMin?: number;
		routerSessionId?: string;
	}): Promise<string> {
		if (!opts.objective?.trim()) throw new Error("objective 不能为空");
		const loc = this.deps.workspaces.locate(opts.workspaceId);
		if (!loc.cwd) throw new Error("目标工作区不存在");
		if (!loc.projectId) throw new Error("竞赛要求目标为 git 仓库工作区");
		const projectId = loc.projectId;
		const variants = opts.variants?.length ? opts.variants : [{}, {}, {}];
		if (variants.length > 4) throw new Error("竞赛最多 4 路");

		const race: Race = {
			id: `race-${randomUUID().slice(0, 8)}`,
			objective: opts.objective,
			entries: [],
			status: "running",
			createdAt: Date.now(),
		};
		// 先建齐 worktree(失败即整场不开)
		const wts: Array<{ workspaceId: string; branch: string }> = [];
		for (let i = 0; i < variants.length; i++) {
			const wt = await this.deps.workspaces.createWorktree(projectId, `race-${race.id.slice(5)}-${i + 1}`);
			if (!wt.ok) throw new Error(`竞赛 worktree 创建失败(${i + 1}/${variants.length}):${wt.error}`);
			wts.push({ workspaceId: wt.workspaceId, branch: wt.branch ?? "" });
		}
		for (let i = 0; i < variants.length; i++) {
			const mk = variants[i].modelKey ?? "";
			if (mk && !parseModelKey(mk)) throw new Error(`模型 key 不合法:${mk}`);
			const w = this.deps.orchestrator.spawnWorker({
				objective: opts.objective,
				workspaceId: wts[i].workspaceId,
				modelKey: mk,
				timeoutMin: opts.timeoutMin,
				routerSessionId: opts.routerSessionId,
			});
			race.entries.push({
				workerId: w.id,
				workspaceId: wts[i].workspaceId,
				branch: wts[i].branch,
				modelKey: mk,
				status: w.status, // 同步采用当前态(异步竞态下不丢 running)
			});
		}
		this.races.unshift(race);
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
		this.emit({ type: "host.log", level: "info", message: `竞赛 ${race.id} 开赛:${variants.length} 路并行(隔离 worktree)` });
		return race.id;
	}

	private async onWorkerUpdate(rec: { id: string; status: RaceEntry["status"]; summary?: string; error?: string }) {
		const race = this.races.find((r) => r.status === "running" && r.entries.some((e) => e.workerId === rec.id));
		if (!race) return;
		const entry = race.entries.find((e) => e.workerId === rec.id)!;
		const terminal = rec.status !== "queued" && rec.status !== "running";
		if (!terminal) {
			entry.status = rec.status;
			return;
		}
		entry.status = rec.status;
		entry.summary = rec.summary;
		entry.error = rec.error;
		if (rec.status === "done") {
			try {
				await this.scoreAndCommit(race, entry);
			} catch (err: any) {
				entry.error = String(err?.message ?? err);
			}
		}
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
		this.maybeAwaitReview(race);
	}

	/** 打分(Q2:测试与检查项各半)+ commit(合入需要已提交分支) */
	private async scoreAndCommit(race: Race, entry: RaceEntry) {
		const v = this.deps.verify;
		const loc = this.deps.workspaces.locate(entry.workspaceId);
		if (!loc.cwd) throw new Error("entry 工作区丢失");
		let score = 0;
		const all = v.scanTests(loc.cwd);
		const st = await v.gitStatus(entry.workspaceId);
		const changed = st.ok ? st.changes.map((c) => c.path) : [];
		entry.changedFiles = changed;
		const selected = v.mapTests(changed, all);
		if (selected.length) {
			const t = await v.runTests(loc.cwd, selected, all.length);
			const passed = t.results.filter((x) => x.status === "pass").length;
			score += Math.round((passed / Math.max(1, t.results.length)) * 50);
		} else {
			score += 50; // 无关联用例不扣
		}
		const c = await v.runChecks(entry.workspaceId);
		if (c.ok && c.results.length) {
			score += Math.round((c.results.filter((x) => x.passed).length / c.results.length) * 50);
		} else {
			score += 50; // 无检查项不扣
		}
		entry.score = score;
		entry.verified = score >= 100 ? "green" : score > 0 ? "skipped" : "red";
		// commit(无变更 → 无 sha,评分即结果)
		const commitMsg = `Agent · 竞赛 ${race.id}:${entry.workerId}`;
		const commitRes = await this.commitFn(entry.workspaceId, commitMsg);
		if (commitRes.ok) entry.sha = commitRes.sha;
		this.maybeAwaitReview(race);
	}

	/** 收口判定:全部 entry 终态且全部 done 已打分,才转 awaiting-review(并发收束不抢跑) */
	private maybeAwaitReview(race: Race) {
		if (race.status !== "running") return;
		const allTerminal = race.entries.every((e) => e.status !== "queued" && e.status !== "running");
		const allScored = race.entries.every((e) => e.status !== "done" || e.score !== undefined);
		if (!allTerminal || !allScored) return;
		race.status = "awaiting-review";
		const best = [...race.entries].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
		this.emit({
			type: "host.log",
			level: "info",
			message: `竞赛 ${race.id} 收口,等待选优(最高分:${best?.score ?? "-"});全部评分见竞赛面板`,
		});
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
	}

	/** 选优:胜者经评审队列合入主线;全部 entry worktree 清理 */
	async resolve(raceId: string, winnerWorkerId: string, note?: string): Promise<{ mergedSha?: string }> {
		const race = this.get(raceId);
		if (!race) throw new Error(`竞赛不存在:${raceId}`);
		if (race.status !== "awaiting-review") throw new Error(`竞赛状态为 ${race.status},不可裁定`);
		const winner = race.entries.find((e) => e.workerId === winnerWorkerId);
		if (!winner) throw new Error("胜者 entry 不存在");
		if (!winner.sha) throw new Error("胜者无提交(无变更或未收口),不可合入");

		// 走评审队列:入队 → 立即 approve(竞赛裁定即人工决策;复用 ff/rebase 合并逻辑)
		this.deps.review.enqueueCommit(winner.workspaceId, winner.branch, winner.sha, `Agent · 竞赛胜者 ${race.id}`);
		const item = this.deps.review.pendingCommitItem(winner.workspaceId, winner.sha);
		if (!item) throw new Error("评审项入队失败");
		const approved = await this.deps.review.decide(item.id, "approve");
		if (!approved.ok) throw new Error(`合并失败:${approved.error}`);
		race.status = "resolved";
		race.resolution = "merged";
		race.winnerEntryId = winner.workerId;
		race.resolvedAt = Date.now();
		race.note = note;
		await this.cleanupEntries(race);
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
		this.emit({ type: "host.log", level: "info", message: `竞赛 ${race.id} 裁定:胜者 ${winner.workerId} 已合入主线(${approved.merged?.sha})` });
		return { mergedSha: approved.merged?.sha };
	}

	/** 全部丢弃 */
	async discard(raceId: string, note?: string) {
		const race = this.get(raceId);
		if (!race) throw new Error(`竞赛不存在:${raceId}`);
		if (race.status === "resolved") throw new Error("竞赛已裁定");
		await this.cleanupEntries(race);
		race.status = "resolved";
		race.resolution = "discarded";
		race.resolvedAt = Date.now();
		race.note = note;
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
	}

	/** 取消运行中竞赛:中断 Worker + 清理 */
	async cancel(raceId: string) {
		const race = this.get(raceId);
		if (!race) throw new Error(`竞赛不存在:${raceId}`);
		if (race.status !== "running") throw new Error(`竞赛状态为 ${race.status},不可取消`);
		for (const e of race.entries) {
			await this.deps.orchestrator.stopWorker(e.workerId).catch(() => {});
		}
		await this.cleanupEntries(race);
		race.status = "cancelled";
		race.resolvedAt = Date.now();
		this.persist();
		this.emit({ type: "race.updated", raceId: race.id });
	}

	private async cleanupEntries(race: Race) {
		const first = race.entries[0];
		const loc = this.deps.workspaces.locate(first?.workspaceId ?? "");
		const projectId = loc.projectId;
		if (!projectId) return;
		for (const e of race.entries) {
			await this.deps.workspaces.removeWorktree(projectId, e.workspaceId).catch(() => {});
		}
	}

	private persist() {
		try {
			writeFileSync(this.storePath, JSON.stringify({ races: this.races }, null, "\t"));
		} catch (e) {
			this.emit({ type: "host.log", level: "warn", message: `races.json 写入失败:${String(e)}` });
		}
	}
}
