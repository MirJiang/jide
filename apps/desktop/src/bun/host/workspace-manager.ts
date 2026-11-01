/**
 * WorkspaceManager — 工作区模型(business-design §3,W1-W4)
 *
 *  - Project = 一个 git 仓库 + 信任状态(持久化到 runtime/projects.json)
 *  - Workspace = Default(主工作区,main 分支)或 worktree(隔离区)
 *  - 切换 = 原子换入换出(UI 持整套上下文;宿主按 workspaceId 寻址一切资源)
 *
 * git 操作走 git CLI(Bun.spawn),全部集中在 runGit()。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { EmitFn } from "./agent-host";

export interface ProjectRecord {
	id: string;
	root: string;
	name: string;
	trusted: boolean;
	activeWorkspaceId: string | null;
	/** worktree 血缘元数据(P3:stacked 语义;workspace 本体由 git 枚举,元数据在此持久化) */
	worktrees?: Record<string, WorktreeMeta>;
}

/** worktree 血缘(P3.2):父工作区/创建基点/来源 */
export interface WorktreeMeta {
	/** 父工作区 id(stacked 子工作区);缺省 = 基于主线 */
	parentWorkspaceId?: string;
	/** 创建基点(分支名或 ref) */
	baseRef?: string;
	/** 创建来源:user = 用户手动;stack = 父子堆叠;race/spec/auto = 自动化域 */
	source: "user" | "stack" | "race" | "spec" | "auto";
	createdAt: number;
}

export interface WorkspaceInfo {
	id: string;
	kind: "default" | "worktree";
	branch: string;
	path: string;
	baseRef?: string;
	/** 血缘:父工作区(stacked) */
	parentWorkspaceId?: string;
	/** 血缘:创建来源 */
	source?: WorktreeMeta["source"];
}

interface TrustStore {
	projects: Record<string, ProjectRecord>;
}

function copyDirSync(src: string, dest: string) {
	mkdirSync(dest, { recursive: true });
	for (const e of readdirSync(src, { withFileTypes: true })) {
		const s = join(src, e.name);
		const d = join(dest, e.name);
		if (e.isDirectory()) copyDirSync(s, d);
		else copyFileSync(s, d);
	}
}

async function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, out: out.trim(), err: err.trim() };
}

export class WorkspaceManager {
	private store: TrustStore = { projects: {} };
	private storePath: string;
	private emit: EmitFn = () => {};
	/** projectId -> workspaces(运行期枚举自 git worktree list) */
	private workspacesCache = new Map<string, WorkspaceInfo[]>();

	constructor(runtimeRoot: string) {
		mkdirSync(runtimeRoot, { recursive: true });
		this.storePath = join(runtimeRoot, "projects.json");
		if (existsSync(this.storePath)) {
			try {
				this.store = JSON.parse(readFileSync(this.storePath, "utf8"));
			} catch {
				this.store = { projects: {} };
			}
		}
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private persist() {
		writeFileSync(this.storePath, JSON.stringify(this.store, null, "\t"));
	}

	getProject(projectId: string): ProjectRecord | undefined {
		return this.store.projects[projectId];
	}

	/** W1:打开项目(不要求信任;返回信任状态供 UI 决定门禁) */
	async openProject(path: string) {
		const root = path;
		if (!existsSync(join(root, ".git"))) {
			return { opened: false as const, reason: "不是 git 仓库(或路径不存在)" };
		}
		const id = this.projectIdFor(root);
		const existing = this.store.projects[id];
		if (!existing) {
			const rec: ProjectRecord = {
				id,
				root,
				name: basename(root),
				trusted: false,
				activeWorkspaceId: null,
			};
			this.store.projects[id] = rec;
			this.persist();
		}
		const rec = this.store.projects[id];
		const branch = await this.currentBranch(root);
		const workspaces = await this.listWorkspaces(id);
		// 悬空活动工作区(如 worktree 已被删除)回落到 Default
		if (workspaces.length > 0 && (!rec.activeWorkspaceId || !workspaces.some((w) => w.id === rec.activeWorkspaceId))) {
			rec.activeWorkspaceId = workspaces[0].id;
			this.persist();
		}
		return { opened: true as const, project: rec, branch, workspaces };
	}

	/** W1:信任门 —— 显式信任 */
	trustProject(projectId: string) {
		const rec = this.store.projects[projectId];
		if (!rec) return false;
		rec.trusted = true;
		this.persist();
		this.emit({ type: "host.log", level: "info", message: `项目已信任:${rec.name}` });
		return true;
	}

	/** 未信任 → 一切写操作/命令执行被拒(由各服务调用) */
	requireTrusted(projectId: string): { ok: true } | { ok: false; error: string } {
		const rec = this.store.projects[projectId];
		if (!rec) return { ok: false, error: "项目未打开" };
		if (!rec.trusted) return { ok: false, error: "项目未信任(W1):禁止命令执行与文件写入" };
		return { ok: true };
	}

	private projectIdFor(root: string) {
		// 稳定 id:绝对路径的 sha1 前 16
		return Buffer.from(root.toLowerCase()).toString("base64url").slice(0, 16);
	}

	async currentBranch(cwd: string): Promise<string | null> {
		const r = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		return r.code === 0 ? r.out : null;
	}

	/** 枚举工作区:Default(仓库根)+ 全部 worktree;血缘元数据合并自 projects.json */
	async listWorkspaces(projectId: string): Promise<WorkspaceInfo[]> {
		const rec = this.store.projects[projectId];
		if (!rec) return [];
		const r = await runGit(rec.root, ["worktree", "list", "--porcelain"]);
		const result: WorkspaceInfo[] = [];
		if (r.code === 0) {
			for (const block of r.out.split("\n\n")) {
				const lines = block.split("\n").filter(Boolean);
				const pathLine = lines.find((l) => l.startsWith("worktree "));
				if (!pathLine) continue;
				const wtPath = pathLine.slice("worktree ".length);
				const branchLine = lines.find((l) => l.startsWith("branch "));
				const branch = branchLine
					? branchLine.slice("branch refs/heads/".length)
					: (await this.currentBranch(wtPath)) ?? "(detached)";
				const isDefault = wtPath.replace(/\\/g, "/") === rec.root.replace(/\\/g, "/");
				const id = isDefault ? `${projectId}:default` : `${projectId}:wt:${branch}`;
				const meta = !isDefault ? rec.worktrees?.[id] : undefined;
				result.push({
					id,
					kind: isDefault ? "default" : "worktree",
					branch,
					path: wtPath,
					...(meta?.baseRef ? { baseRef: meta.baseRef } : {}),
					...(meta?.parentWorkspaceId ? { parentWorkspaceId: meta.parentWorkspaceId } : {}),
					...(meta ? { source: meta.source } : {}),
				});
			}
		}
		// 排序:Default 在前
		result.sort((a, b) => (a.kind === "default" ? -1 : b.kind === "default" ? 1 : a.branch.localeCompare(b.branch)));
		this.workspacesCache.set(projectId, result);
		return result;
	}

	getWorkspace(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
		return (this.workspacesCache.get(projectId) ?? []).find((w) => w.id === workspaceId);
	}

	/** 反查:路径 → {projectId, workspaceId}(会话创建时给工具桥路由用;worktree 路径已在缓存则直接命中) */
	async findByPath(path: string): Promise<{ projectId: string; workspaceId: string } | null> {
		const norm = path.replace(/[\\/]+$/, "").toLowerCase();
		for (const rec of Object.values(this.store.projects)) {
			for (const w of this.workspacesCache.get(rec.id) ?? []) {
				if (w.path.replace(/[\\/]+$/, "").toLowerCase() === norm) {
					return { projectId: rec.id, workspaceId: w.id };
				}
			}
			for (const w of await this.listWorkspaces(rec.id)) {
				if (w.path.replace(/[\\/]+$/, "").toLowerCase() === norm) {
					return { projectId: rec.id, workspaceId: w.id };
				}
			}
		}
		return null;
	}

	/** W3/P3.2:创建隔离工作区(git worktree add)。opts.parentWorkspaceId = stacked 子工作区(基点 = 父分支 HEAD)。仅已信任项目。 */
	async createWorktree(
		projectId: string,
		name: string,
		opts: { fromRef?: string; parentWorkspaceId?: string; source?: WorktreeMeta["source"] } = {},
	) {
		const rec = this.store.projects[projectId];
		if (!rec) return { ok: false as const, error: "项目未打开" };
		const trust = this.requireTrusted(projectId);
		if (!trust.ok) return { ok: false as const, error: trust.error };

		let ref = opts.fromRef;
		if (!ref && opts.parentWorkspaceId) {
			// stacked 血缘:基点 = 父工作区分支当前 HEAD(随父推进可 rebase/合链)
			const pid = opts.parentWorkspaceId.split(":")[0];
			const pInfo = (await this.listWorkspaces(pid)).find((w) => w.id === opts.parentWorkspaceId);
			if (!pInfo) return { ok: false as const, error: `父工作区不存在:${opts.parentWorkspaceId}` };
			if (!pInfo.branch || pInfo.branch === "(detached)") return { ok: false as const, error: "父工作区分支不可用(detached)" };
			ref = pInfo.branch;
		}
		const baseRef = ref ?? "HEAD";

		const branch = `jide/${name}`;
		const parent = join(rec.root, "..");
		const wtPath = join(parent, `${basename(rec.root)}-wt-${name}`);
		const r = await runGit(rec.root, ["worktree", "add", "-b", branch, wtPath, baseRef]);
		if (r.code !== 0) return { ok: false as const, error: `git worktree add 失败:${r.err || r.out}` };

		// W3:创建即复制工作区上下文(检查项 .jide/checks 与记忆 .memory —— 未提交的也带上)
		for (const rel of [".jide/checks", ".memory"]) {
			const src = join(rec.root, rel);
			if (!existsSync(src)) continue;
			try {
				copyDirSync(src, join(wtPath, rel));
			} catch { /* 复制失败不阻塞创建 */ }
		}
		// P3.2:血缘落盘(projects.json)
		const workspaceId = `${projectId}:wt:${branch}`;
		if (!rec.worktrees) rec.worktrees = {};
		rec.worktrees[workspaceId] = {
			...(opts.parentWorkspaceId ? { parentWorkspaceId: opts.parentWorkspaceId } : {}),
			baseRef,
			source: opts.source ?? (opts.parentWorkspaceId ? "stack" : "user"),
			createdAt: Date.now(),
		};
		this.persist();
		await this.listWorkspaces(projectId); // 刷缓存
		this.emit({ type: "host.log", level: "info", message: `隔离工作区已创建:${branch}${opts.parentWorkspaceId ? `(基于 ${opts.parentWorkspaceId.split(":")[1] ?? opts.parentWorkspaceId})` : ""}` });
		return {
			ok: true as const,
			workspaceId,
			path: wtPath,
			branch,
		};
	}

	/** P3:移除 worktree(竞赛落选清理/手动清理),连带删除其分支;Default 不可移除;有子工作区时拒绝 */
	async removeWorktree(projectId: string, workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const rec = this.store.projects[projectId];
		if (!rec) return { ok: false as const, error: "项目未打开" };
		const info = (await this.listWorkspaces(projectId)).find((w) => w.id === workspaceId);
		if (!info) return { ok: false as const, error: "工作区不存在" };
		if (info.kind === "default") return { ok: false as const, error: "Default 工作区不可移除" };
		// 血缘守卫:存在未清理的子工作区 → 先处理子级(否则子级 rebase 目标随父分支消失)
		const children = Object.entries(rec.worktrees ?? {}).filter(([, m]) => m.parentWorkspaceId === workspaceId);
		if (children.length) {
			return { ok: false as const, error: `存在 ${children.length} 个子工作区,先移除/合入子级再删父级` };
		}
		const rm = await runGit(rec.root, ["worktree", "remove", "--force", info.path]);
		if (rm.code !== 0) return { ok: false as const, error: `worktree remove 失败:${rm.err || rm.out}` };
		if (info.branch && info.branch !== "(detached)") {
			const bd = await runGit(rec.root, ["branch", "-D", info.branch]);
			if (bd.code !== 0) {
				// 删分支失败不阻塞(worktree 已移除),仅记录
				this.emit({ type: "host.log", level: "warn", message: `分支删除失败(${info.branch}):${bd.err || bd.out}` });
			}
		}
		if (rec.worktrees) {
			delete rec.worktrees[workspaceId];
			this.persist();
		}
		await this.listWorkspaces(projectId); // 刷缓存
		this.emit({ type: "host.log", level: "info", message: `工作区已移除:${info.branch ?? info.path}` });
		return { ok: true as const };
	}

	/** W4:原子切换(上下文整套换入:由上层按 activeWorkspaceId 重建会话/终端) */
	async switchWorkspace(projectId: string, workspaceId: string) {
		const rec = this.store.projects[projectId];
		if (!rec) return { ok: false as const, error: "项目未打开" };
		const ws = (await this.listWorkspaces(projectId)).find((w) => w.id === workspaceId);
		if (!ws) return { ok: false as const, error: `工作区不存在:${workspaceId}` };
		rec.activeWorkspaceId = workspaceId;
		this.persist();
		this.emit({ type: "workspace.changed", projectId, activeWorkspaceId: workspaceId });
		return { ok: true as const, activeWorkspaceId: workspaceId };
	}

	/* ---------------- git 呈现 ---------------- */

	async gitStatus(workspaceId: string) {
		const { cwd, projectId } = this.locate(workspaceId);
		if (!cwd) return { ok: false as const, error: "工作区不存在" };
		const st = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
		if (st.code !== 0) return { ok: false as const, error: st.err };
		const lines = st.out.split("\n");
		const branchLine = lines[0] ?? "";
		const branch = branchLine.match(/## ([^.]+)/)?.[1]?.trim() ?? "HEAD";
		const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0);
		const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0);
		const changes = lines
			.slice(1)
			.filter(Boolean)
			.map((line) => {
				const staged = line[0] !== " " && line[0] !== "?";
				const ch = line[0] !== " " ? line[0] : line[1];
				const kind = ch === "M" ? ("M" as const) : ch === "A" ? ("A" as const) : ch === "D" ? ("D" as const) : ("?" as const);
				return { path: line.slice(3), staged, kind };
			});
		return { ok: true as const, branch, changes, ahead, behind };
	}

	async gitLog(workspaceId: string, limit = 50) {
		const { cwd } = this.locate(workspaceId);
		if (!cwd) return { ok: false as const, error: "工作区不存在" };
		const r = await runGit(cwd, [
			"log",
			`-n`,
			String(limit),
			"--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D",
		]);
		if (r.code !== 0) return { ok: false as const, error: r.err };
		const commits = r.out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha, shortSha, message, author, date, refNames] = line.split("\x1f");
				return {
					sha,
					shortSha,
					message,
					author,
					date,
					refs: (refNames ?? "").split(", ").map((s) => s.replace(/^tag: /, "")).filter((s) => s && s !== "HEAD"),
					isAgent: author === "JIDE Agent",
				};
			});
		return { ok: true as const, commits };
	}

	/** 路径 → workspaceId(遍历已登记项目的工作区;找不到返回 null) */
	async resolveWorkspaceId(path: string): Promise<string | null> {
		if (!path) return null;
		const norm = (p: string) =>
			p.replace(/[\\/]+/g, "/").toLowerCase().replace(/\/$/, "");
		for (const rec of Object.values(this.store.projects)) {
			for (const w of await this.listWorkspaces(rec.id)) {
				if (norm(w.path) === norm(path)) return w.id;
			}
		}
		return null;
	}

	/** diff 双全文(§6):HEAD 版本 vs 工作区版本 */
	async fileDiff(workspaceId: string, relPath: string): Promise<
		{ ok: true; headContent: string; workContent: string; headExists: boolean } | { ok: false; error: string }
	> {
		const { cwd } = this.locate(workspaceId);
		if (!cwd) return { ok: false, error: "工作区不存在" };
		const show = await runGit(cwd, ["show", "HEAD:" + relPath.replace(/\\/g, "/")]);
		const headExists = show.code === 0;
		let workContent = "";
		try {
			workContent = readFileSync(join(cwd, relPath), "utf8");
		} catch {
			workContent = ""; // 新文件/已删除
		}
		return { ok: true, headContent: headExists ? show.out : "", workContent, headExists };
	}

	/** 同步:fetch --all(远端不可达时静默返回 fetched:false) */
	async sync(workspaceId: string) {
		const { cwd } = this.locate(workspaceId);
		if (!cwd) return { ok: false as const, error: "工作区不存在" };
		const fetchR = await runGit(cwd, ["fetch", "--all"]);
		const st = await this.gitStatus(workspaceId);
		return st.ok
			? { ok: true as const, fetched: fetchR.code === 0, ahead: st.ahead, behind: st.behind }
			: { ok: false as const, error: st.error };
	}

	/** 远端 compare URL(用于拉取请求入口) */
	async remoteCompareUrl(workspaceId: string): Promise<string | null> {
		const { cwd } = this.locate(workspaceId);
		if (!cwd) return null;
		const r = await runGit(cwd, ["remote", "get-url", "origin"]);
		if (r.code !== 0) return null;
		// git@github.com:owner/repo.git 或 https://github.com/owner/repo.git → owner/repo
		const m = r.out.match(/github\.com[/:](.+?)(?:\.git)?$/);
		if (!m) return null;
		const branchR = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const branch = branchR.code === 0 ? branchR.out : "";
		if (!branch || branch === "main") return null;
		return `https://github.com/${m[1]}/compare/main...${branch}?expand=1`;
	}

	locate(workspaceId: string): { cwd: string | null; projectId: string | null } {
		const projectId = workspaceId.split(":")[0];
		const rec = this.store.projects[projectId];
		if (!rec) return { cwd: null, projectId: null };
		const ws = this.workspacesCache.get(projectId)?.find((w) => w.id === workspaceId);
		if (ws) return { cwd: ws.path, projectId };
		// 缓存未命中时:default 即仓库根
		if (workspaceId === `${projectId}:default`) return { cwd: rec.root, projectId };
		return { cwd: null, projectId };
	}

	/** W5:提交(隔离区计划步骤用)。message 以 "Agent · 计划步骤" 标注。 */
	async commitAll(workspaceId: string, message: string, asAgent: boolean) {
		const { cwd, projectId } = this.locate(workspaceId);
		if (!cwd || !projectId) return { ok: false as const, error: "工作区不存在" };
		const trust = this.requireTrusted(projectId);
		if (!trust.ok) return { ok: false as const, error: trust.error };
		const ws = this.workspacesCache.get(projectId)?.find((w) => w.id === workspaceId);
		if (ws?.kind === "default" && asAgent) {
			return { ok: false as const, error: "W2/W5:Default 工作区禁止计划步骤自动提交" };
		}
		const author = asAgent ? '-c=user.name=JIDE Agent' : null;
		const args = ["add", "-A"];
		const add = await runGit(cwd, args);
		if (add.code !== 0) return { ok: false as const, error: add.err };
		const commitArgs = asAgent
			? ["-c", "user.name=JIDE Agent", "-c", "user.email=agent@jide.local", "commit", "-m", message]
			: ["commit", "-m", message];
		const commit = await runGit(cwd, commitArgs);
		if (commit.code !== 0) {
			// nothing to commit 也算成功幂等
			if (commit.out.includes("nothing to commit") || commit.err.includes("nothing to commit")) {
				return { ok: false as const, error: "nothing to commit" };
			}
			return { ok: false as const, error: commit.err || commit.out };
		}
		const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
		this.emit({ type: "git.commits-updated", workspaceId });
		return { ok: true as const, sha: sha.out, message };
	}
}
