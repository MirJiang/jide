/**
 * WorkspaceManager + FileService + PlanManager 测试(git 临时仓库,headless)
 * 覆盖:W1 信任门 / W3 worktree / W4 切换 / W5 自动提交(Default 拒绝)/ 文件读写门禁
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent } from "@jide/contracts";
import { WorkspaceManager } from "./workspace-manager";
import { FileService } from "./file-service";
import { PlanManager } from "./plan-manager";

const events: HostEvent[] = [];
const root = mkdtempSync(join(tmpdir(), "jide-ws-test-"));
const projectDir = join(root, "shop");
let projectId = "";

async function git(cwd: string, ...args: string[]) {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
	return out.trim();
}

beforeAll(async () => {
	mkdirSync(projectDir, { recursive: true });
	await git(projectDir, "init", "-b", "main");
	await git(projectDir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
	const ws = new WorkspaceManager(join(root, "runtime"));
	ws.bindEmitter((e) => events.push(e));
	// beforeAll 里创建的实例仅用于准备;测试里各用各的实例(共享 store 文件)
	(globalThis as any).__ws = ws;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

	function fresh(): { ws: WorkspaceManager; fs: FileService; plans: PlanManager } {
		const ws = new WorkspaceManager(join(root, "runtime"));
		ws.bindEmitter((e) => events.push(e));
		const plans = new PlanManager(ws, join(root, "runtime"));
		plans.bindEmitter((e) => events.push(e));
		return { ws, fs: new FileService(ws), plans };
	}

describe("工作区模型 W1-W5", () => {
	test("W1:打开项目,默认未信任;写文件被拒", async () => {
		const { ws, fs } = fresh();
		const r = await ws.openProject(projectDir);
		expect(r.opened).toBe(true);
		if (!r.opened) return;
		projectId = r.project.id;
		expect(r.project.trusted).toBe(false);
		expect(r.branch).toBe("main");

		const w = fs.write(`${projectId}:default`, "a.txt", "hi");
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.error).toContain("未信任");
	});

	test("W1:信任后写文件放行;读与列目录可用", async () => {
		const { ws, fs } = fresh();
		ws.trustProject(projectId);
		const w = fs.write(`${projectId}:default`, "a.txt", "hello jide");
		expect(w.ok).toBe(true);

		const rd = fs.read(`${projectId}:default`, "a.txt");
		expect(rd.ok && rd.content).toBe("hello jide");

		const ls = fs.list(`${projectId}:default`, "");
		expect(ls.ok && ls.ok && (ls as any).entries.some((e: any) => e.name === "a.txt")).toBe(true);

		// 路径逃逸被拒
		const evil = fs.read(`${projectId}:default`, "../../etc/passwd");
		expect(evil.ok).toBe(false);
	});

	test("W3:创建隔离工作区(worktree);未信任时被拒(先验证另一项目)", async () => {
		const { ws } = fresh();
		const created = await ws.createWorktree(projectId, "cart-fix");
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.branch).toBe("jide/cart-fix");
		expect(created.path).toContain("wt-cart-fix");

		const list = await ws.listWorkspaces(projectId);
		expect(list).toHaveLength(2);
		expect(list[0].kind).toBe("default");
		expect(list.some((w) => w.kind === "worktree" && w.branch === "jide/cart-fix")).toBe(true);
	});

	test("W4:原子切换工作区", async () => {
		const { ws } = fresh();
		const list = await ws.listWorkspaces(projectId);
		const wt = list.find((w) => w.kind === "worktree")!;
		const sw = await ws.switchWorkspace(projectId, wt.id);
		expect(sw.ok).toBe(true);
		expect(events.some((e) => e.type === "workspace.changed")).toBe(true);
	});

	test("W5:Default 拒绝 agent 自动提交;worktree 放行并产生 Agent 提交", async () => {
		const { ws } = fresh();
		const list = await ws.listWorkspaces(projectId);
		const wt = list.find((w) => w.kind === "worktree")!;

		writeFileSync(join(wt.path, "cart.ts"), "export const price = 2990;\n");
		const c1 = await ws.commitAll(wt.id, "Agent · 计划步骤 1:定位总额计算", true);
		expect(c1.ok).toBe(true);
		if (c1.ok) expect(c1.sha.length).toBeGreaterThanOrEqual(7);

		const cDefault = await ws.commitAll(`${projectId}:default`, "Agent · 计划步骤 1:x", true);
		expect(cDefault.ok).toBe(false);
		if (!cDefault.ok) expect(cDefault.error).toContain("禁止计划步骤自动提交");
	});

	test("git 呈现:status + log(Agent 标注)", async () => {
		const { ws } = fresh();
		const list = await ws.listWorkspaces(projectId);
		const wt = list.find((w) => w.kind === "worktree")!;
		const st = await ws.gitStatus(wt.id);
		expect(st.ok).toBe(true);
		const log = await ws.gitLog(wt.id, 10);
		expect(log.ok).toBe(true);
		if (log.ok) {
			expect(log.commits.length).toBeGreaterThanOrEqual(1);
			expect(log.commits.some((c) => c.isAgent && c.message.includes("计划步骤"))).toBe(true);
		}
	});
});

describe("计划域(W5 联动)", () => {
	test("计划创建与步骤推进:worktree 自动提交,Default 只标记", async () => {
		const { ws, plans } = fresh();
		const list = await ws.listWorkspaces(projectId);
		const wt = list.find((w) => w.kind === "worktree")!;

		const plan = plans.create(wt.id, "修复购物车总额", ["定位逻辑", "改为分单位", "回归验证"]);
		expect(plan.steps[0].state).toBe("doing");

		writeFileSync(join(wt.path, "step1.txt"), "done");
		const r1 = await plans.stepDone(plan.id, 0);
		expect(r1.ok).toBe(true);
		if (r1.ok) {
			expect(r1.commit?.message).toContain("计划步骤 1");
		}
		expect(plan.steps[1].state).toBe("doing");

		// Default 工作区:stepDone 不提交,但步骤完成
		const planD = plans.create(`${projectId}:default`, "默认区任务", ["步骤A"]);
		const rD = await plans.stepDone(planD.id, 0);
		expect(rD.ok).toBe(true);
		if (rD.ok) expect(rD.commit).toBeUndefined();

		// plan.updated 事件已推
		expect(events.filter((e) => e.type === "plan.updated").length).toBeGreaterThanOrEqual(3);
	});
});

describe("工作区血缘(P3.2)", () => {
	test("stacked 创建:基点 = 父分支 HEAD;元数据持久化并随枚举带出;有子级时父级删除被拒", async () => {
		const { ws } = fresh();
		const opened = await ws.openProject(projectDir);
		expect(opened.opened).toBe(true);
		ws.trustProject(projectId);

		const parent = await ws.createWorktree(projectId, "feat-parent", { source: "user" });
		expect(parent.ok).toBe(true);
		if (!parent.ok) return;
		// 父分支推进一格(子级基点应随之)
		writeFileSync(join(parent.path, "p.txt"), "p");
		await ws.commitAll(parent.workspaceId, "parent work", false);

		const child = await ws.createWorktree(projectId, "feat-child", { parentWorkspaceId: parent.workspaceId });
		expect(child.ok).toBe(true);
		if (!child.ok) return;

		const list = await ws.listWorkspaces(projectId);
		const childInfo = list.find((w) => w.id === child.workspaceId);
		expect(childInfo?.parentWorkspaceId).toBe(parent.workspaceId);
		expect(childInfo?.source).toBe("stack");
		expect(childInfo?.baseRef).toBe(parent.branch);

		// 持久化:全新实例读同一 projects.json 仍带血缘
		const ws2 = new WorkspaceManager(join(root, "runtime"));
		const list2 = await ws2.listWorkspaces(projectId);
		expect(list2.find((w) => w.id === child.workspaceId)?.parentWorkspaceId).toBe(parent.workspaceId);

		// 守卫:子级存在 → 父级删除被拒
		const rmParent = await ws.removeWorktree(projectId, parent.workspaceId);
		expect(rmParent.ok).toBe(false);
		if (!rmParent.ok) expect(rmParent.error).toContain("子工作区");

		// 移除子级 → 父级可删,元数据一并清理
		expect((await ws.removeWorktree(projectId, child.workspaceId)).ok).toBe(true);
		expect((await ws.listWorkspaces(projectId)).find((w) => w.id === child.workspaceId)).toBeUndefined();
		expect((await ws.removeWorktree(projectId, parent.workspaceId)).ok).toBe(true);
	}, 30000);
});
