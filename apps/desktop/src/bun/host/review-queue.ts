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

export interface ReviewItem {
	id: string;
	kind: "commit" | "memory" | "checks";
	title: string;
	detail: string;
	workspaceId?: string;
	branch?: string;
	/** commit 型:要合并的分支头 sha */
	sha?: string;
	state: "pending" | "approved" | "asked" | "ignored";
	createdAt: string;
}

async function git(cwd: string, args: string[]) {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
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

	/** 计划自动提交入队(commit 型) */
	enqueueCommit(workspaceId: string, branch: string, sha: string, message: string) {
		this.push({
			id: `rv-${this.nextId++}`,
			kind: "commit",
			title: message.split("\n")[0],
			detail: `自动提交 ${sha.slice(0, 7)} · 分支 ${branch}`,
			workspaceId,
			branch,
			sha,
			state: "pending",
			createdAt: new Date().toISOString(),
		});
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
	 *  - Default 领先(分叉)→ 先 rebase 隔离分支 onto main,再 ff
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

		// 尝试 fast-forward 合并隔离分支
		let merge = await git(mainCwd, ["merge", "--ff-only", item.branch]);
		if (merge.code !== 0) {
			// 分叉:在隔离工作区内 rebase 到主线头,再回主线 ff
			const wsInfo = this.workspaces.getWorkspace(projectId, item.workspaceId);
			if (!wsInfo) {
				this.persist();
				return { ok: false as const, error: "隔离工作区不存在" };
			}
			const rb = await git(wsInfo.path, ["rebase", "main"]);
			if (rb.code !== 0) {
				item.state = "pending";
				this.persist();
				return { ok: false as const, error: `合并失败(rebase):${rb.err || rb.out}` };
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
