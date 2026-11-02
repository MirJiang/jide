/**
 * ReviewQueue — 评审队列(W6,人工门禁)
 *
 *  - 入队:计划步骤自动提交(每个 Agent 提交)/ 记忆建议(M4)/ 检查项结果
 *  - 决策:通过 → 快进合并进主线(Default 工作区分支);追问 → 留待回聊;忽略 → 留档
 *  - 合并语义:隔离分支 → Default 主分支,优先 fast-forward;有分叉时 rebase 后快进
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EmitFn } from "./agent-host";
import type { WorkspaceManager } from "./workspace-manager";
import { spawn } from "../../runtime";

export interface ReviewItem {
	id: string;
	kind: "commit" | "memory" | "checks";
	title: string;
	detail: string;
	workspaceId?: string;
	branch?: string;
	/** commit 型:要合并的分支头 sha */
	sha?: string;
	/** commit 型:该分支的基分支(P3.2 stacked 血缘;rebase 目标,缺省 = 主线) */
	baseBranch?: string;
	state: "pending" | "approved" | "asked" | "ignored";
	createdAt: string;
}

async function git(cwd: string, args: string[]) {
	const proc = spawn(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LC_ALL: "C" },
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, out: out.trim(), err: err.trim() };
}

export class ReviewQueue {
	private items = new Map<string, ReviewItem>();
	private nextId = 1;
	private emit: EmitFn = () => {};
	private storePath: string;

	constructor(private workspaces: WorkspaceManager, runtimeRoot: string) {
		mkdirSync(runtimeRoot, { recursive: true });
		this.storePath = join(runtimeRoot, "review-queue.json");
		if (existsSync(this.storePath)) {
			try {
				const arr = JSON.parse(readFileSync(this.storePath, "utf8")) as ReviewItem[];
				for (const it of arr) this.items.set(it.id, it);
				const maxN = Math.max(0, ...[...this.items.keys()].map((k) => Number(k.replace("rv-", "")) || 0));
				this.nextId = maxN + 1;
			} catch {
				/* fresh */
			}
		}
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private persist() {
		writeFileSync(this.storePath, JSON.stringify([...this.items.values()], null, "\t"));
	}

	private push(item: ReviewItem) {
		this.items.set(item.id, item);
		this.persist();
		this.emit({
			type: "review.updated",
			projectId: item.workspaceId?.split(":")[0] ?? "",
			pending: this.pending().length,
		});
	}

	pending(): ReviewItem[] {
		return [...this.items.values()].filter((i) => i.state === "pending");
	}

	list(projectId: string): ReviewItem[] {
		return [...this.items.values()].filter((i) => !i.workspaceId || i.workspaceId.startsWith(projectId));
	}

	/** 按 sha 定位 pending 的 commit 评审项(竞赛裁定入队后定位;P3) */
	pendingCommitItem(workspaceId: string, sha: string): { id: string } | undefined {
		for (const item of this.items.values()) {
			if (item.kind === "commit" && item.state === "pending" && item.workspaceId === workspaceId && item.sha === sha) {
				return { id: item.id };
			}
		}
		return undefined;
	}

	/** 提交入队(commit 型;同工作区同 sha 的 pending 项幂等去重,返回命中或新建的条目) */
	enqueueCommit(workspaceId: string, branch: string, sha: string, message: string, opts?: { baseBranch?: string }): ReviewItem {
		for (const item of this.items.values()) {
			if (item.kind === "commit" && item.state === "pending" && item.workspaceId === workspaceId && item.sha === sha) {
				return item;
			}
		}
		const created: ReviewItem = {
			id: `rv-${this.nextId++}`,
			kind: "commit",
			title: message.split("\n")[0],
			detail: `提交 ${sha.slice(0, 7)} · 分支 ${branch}${opts?.baseBranch ? ` · 基于 ${opts.baseBranch}` : ""}`,
			workspaceId,
			branch,
			sha,
			...(opts?.baseBranch ? { baseBranch: opts.baseBranch } : {}),
			state: "pending",
			createdAt: new Date().toISOString(),
		};
		this.push(created);
		return created;
	}

	enqueueMemory(workspaceId: string, title: string, detail: string) {
		this.push({
			id: `rv-${this.nextId++}`,
			kind: "memory",
			title,
			detail,
			workspaceId,
			state: "pending",
			createdAt: new Date().toISOString(),
		});
	}

	enqueueChecks(workspaceId: string, passed: number, total: number) {
		this.push({
			id: `rv-${this.nextId++}`,
			kind: "checks",
			title: `检查项结果 ${passed}/${total}`,
			detail: passed === total ? "全部通过" : "存在失败项",
			workspaceId,
			state: "pending",
			createdAt: new Date().toISOString(),
		});
	}

	/**
	 * 决策。approve(commit 型)→ 合并进 Default 主分支:
	 *  - Default 在同一提交或落后(可 ff)→ ff
	 *  - Default 领先(分叉)→ 先 rebase 隔离分支 onto 主线头,再 ff
	 *  - stacked 血缘(P3.2):baseBranch 尚未合入主线 → 拒绝(合链必须自底向上;守卫通过后
	 *    父内容已在主线,rebase onto 主线头语义安全)
	 */
	async decide(id: string, decision: "approve" | "ask" | "ignore", note?: string) {
		const item = this.items.get(id);
		if (!item) return { ok: false as const, error: `评审项不存在:${id}` };
		if (item.state !== "pending") return { ok: false as const, error: `评审项已处理(${item.state})` };

		if (decision !== "approve") {
			item.state = decision === "ask" ? "asked" : "ignored";
			this.persist();
			return { ok: true as const };
		}

		item.state = "approved";
		if (item.kind !== "commit" || !item.workspaceId || !item.branch) {
			this.persist();
			return { ok: true as const };
		}

		// 合并:在 Default 仓库根执行
		const projectId = item.workspaceId.split(":")[0];
		const rec = this.workspaces.getProject(projectId);
		if (!rec) {
			this.persist();
			return { ok: false as const, error: "项目未找到" };
		}
		const mainCwd = rec.root;
		// 合并目标分支 = 仓库根当前分支(通常 main;不硬编码)
		const hb = await git(mainCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const targetBranch = hb.code === 0 && hb.out ? hb.out : "main";

		// stacked 守卫:基分支必须已在主线(merge-base --is-ancestor);否则合链断裂
		if (item.baseBranch) {
			const anc = await git(mainCwd, ["merge-base", "--is-ancestor", item.baseBranch, "HEAD"]);
			if (anc.code !== 0) {
				item.state = "pending";
				this.persist();
				return { ok: false as const, error: `父分支 ${item.baseBranch} 尚未合入主线,请先合入父工作区(stacked 合链自底向上)` };
			}
		}

		// 尝试 fast-forward 合并隔离分支
		let merge = await git(mainCwd, ["merge", "--ff-only", item.branch]);
		if (merge.code !== 0) {
			// 分叉:在隔离工作区内 rebase 到主线头,再回主线 ff
			const wsInfo = this.workspaces.getWorkspace(projectId, item.workspaceId);
			if (!wsInfo) {
				this.persist();
				return { ok: false as const, error: "隔离工作区不存在" };
			}
			const rb = await git(wsInfo.path, ["rebase", targetBranch]);
			if (rb.code !== 0) {
				item.state = "pending";
				this.persist();
				return { ok: false as const, error: `合并失败(rebase onto ${targetBranch}):${rb.err || rb.out}` };
			}
			merge = await git(mainCwd, ["merge", "--ff-only", item.branch]);
			if (merge.code !== 0) {
				item.state = "pending";
				this.persist();
				return { ok: false as const, error: `合并失败:${merge.err || merge.out}` };
			}
		}
		const sha = await git(mainCwd, ["rev-parse", "--short", "HEAD"]);
		this.persist();
		this.emit({
			type: "git.commits-updated",
			workspaceId: `${projectId}:default`,
		});
		return { ok: true as const, merged: { sha: sha.out, message: item.title } };
	}
}
