/**
 * E2E:P3 域离线验收(不经 UI,直连 daemon;全程不调真实模型)
 * 验证:
 *  A. stacked 血缘:workspace.create(parent)→ 枚举带血缘;用户提交(git.commitAll)→ 送审
 *     (review.enqueueCommit,自动带 baseBranch)→ 守卫(父未合入拒绝)→ 依序合并成功;
 *  B. Router 分派回退:routerModel 指向不存在的 provider → automation(dispatch=router)
 *     → Router 不可用/无接管 → 回退直执(run.dispatched=fallback)→ 任务卡 failed;
 *  C. 任务经历:任务卡终态 → <仓库根>/.memory/project/experience.md 自动落一条;
 *  D. task.updated 事件经 WS 实时可达。
 * 用法:bun apps/desktop/scripts/e2e-tasks-acceptance.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "jide-tasks-e2e-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;
const repoDir = join(workDir, "shop");

function fail(msg: string): never {
	console.error(`\n❌ ${msg}`);
	try {
		proc.kill();
	} catch {
		/* 已退 */
	}
	console.error(`(目录保留:${workDir})`);
	process.exit(1);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim() || out.trim()}`);
	return out.trim();
}

console.log("[0] 仓库夹具(init -b main + 首提交)…");
mkdirSync(repoDir, { recursive: true });
await git(repoDir, "init", "-b", "main");
writeFileSync(join(repoDir, "base.txt"), "base");
await git(repoDir, "add", "-A");
await git(repoDir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "init");

const entry = join(import.meta.dir, "..", "src", "bun", "daemon.ts");
const proc = Bun.spawn([process.execPath, entry], {
	stdin: "ignore",
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env, JIDE_HOME: runtime },
});
let exited = false;
void proc.exited.then((c) => {
	exited = true;
});
let stderrTail = "";
void (async () => {
	const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stderrTail = (stderrTail + new TextDecoder().decode(value)).slice(-4000);
		}
	} catch {
		/* closed */
	}
})();

const daemonDir = join(runtime, "daemon");
let port = 0;
let token = "";
let ready = false;
for (let i = 0; i < 60; i++) {
	if (exited) fail(`daemon 提前退出 · stderr: ${stderrTail.slice(0, 400)}`);
	if (existsSync(join(daemonDir, "port")) && existsSync(join(daemonDir, "token"))) {
		port = Number(readFileSync(join(daemonDir, "port"), "utf8").trim());
		token = readFileSync(join(daemonDir, "token"), "utf8").trim();
		try {
			const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
			if (r.ok) {
				ready = true;
				break;
			}
		} catch {
			/* 尚未就绪 */
		}
	}
	await Bun.sleep(500);
}
if (!ready) fail("daemon 30s 未就绪");
console.log(`  daemon 就绪 :${port}`);

async function rpc(method: string, params?: unknown): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ params: params ?? {} }),
	});
	return { out: await res.json() };
}
const expectOk = (out: any, what: string) => {
	if (!out?.ok) fail(`${what}:${out?.error ?? "非 ok 响应"}`);
};

/* ---- WS 事件通道(先连,后面断言 task.updated 实时可达) ---- */
console.log("[1] WS 事件通道连接…");
const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
const got: any[] = [];
await new Promise<void>((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("WS 5s 未 open")), 5000);
	ws.onopen = () => {
		clearTimeout(t);
		resolve();
	};
	ws.onmessage = (m) => {
		try {
			got.push(JSON.parse(String(m.data)));
		} catch {
			/* 忽略 */
		}
	};
	ws.onerror = () => reject(new Error("WS 错误"));
});
console.log("  connected");

/* ---- A. stacked 血缘 + 送审合链 ---- */
console.log("[2] A:打开项目 + stacked 子/孙工作区…");
const opened = (await rpc("project.open", { path: repoDir })).out;
expectOk(opened, "project.open");
const pid = opened.projectId;
expectOk((await rpc("project.trust", { projectId: pid })).out, "project.trust");
const wsDefault = `${pid}:default`;

const child = (await rpc("workspace.create", { projectId: pid, name: "feat-child", parentWorkspaceId: wsDefault })).out;
expectOk(child, "workspace.create(child)");
const grandchild = (await rpc("workspace.create", { projectId: pid, name: "feat-grand", parentWorkspaceId: child.workspaceId })).out;
expectOk(grandchild, "workspace.create(grandchild)");

const list = (await rpc("workspace.list", { projectId: pid })).out;
expectOk(list, "workspace.list");
const childInfo = list.workspaces.find((w: any) => w.id === child.workspaceId);
const grandInfo = list.workspaces.find((w: any) => w.id === grandchild.workspaceId);
if (childInfo?.parentWorkspaceId !== wsDefault) fail(`child 血缘缺失:${JSON.stringify(childInfo)}`);
if (childInfo?.source !== "stack") fail(`child source 非 stack`);
if (grandInfo?.parentWorkspaceId !== child.workspaceId) fail(`grandchild 血缘缺失`);
if (childInfo?.baseRef !== "main") fail(`child baseRef 非 main:${childInfo?.baseRef}`);
console.log(`  血缘:main ← ${childInfo.branch} ← ${grandInfo.branch} ✓(source=stack)`);

console.log("[3] A:用户提交(git.commitAll)→ 送审 → 守卫 → 合链…");
writeFileSync(join(child.path, "c.txt"), "child-work");
const c1 = (await rpc("git.commitAll", { workspaceId: child.workspaceId, message: "child work" })).out;
expectOk(c1, "git.commitAll(child)");
if (!/^[\da-f]+$/.test(c1.sha)) fail(`commit sha 异常:${c1.sha}`);
writeFileSync(join(grandchild.path, "g.txt"), "grand-work");
const c2 = (await rpc("git.commitAll", { workspaceId: grandchild.workspaceId, message: "grand work" })).out;
expectOk(c2, "git.commitAll(grandchild)");

// 孙先送审(baseBranch = child 分支):父未合入 → 守卫拒绝
const eq1 = (await rpc("review.enqueueCommit", { workspaceId: grandchild.workspaceId, message: "grand 送审" })).out;
expectOk(eq1, "review.enqueueCommit(grandchild)");
const items1 = (await rpc("review.list", { projectId: pid })).out;
expectOk(items1, "review.list");
const grandItem = items1.items.find((i: any) => i.id === eq1.itemId);
if (!grandItem) fail("送审条目未见于 review.list");
if (grandItem.baseBranch !== childInfo.branch) fail(`grand baseBranch 非父分支:${grandItem.baseBranch}`);
const g1 = (await rpc("review.decide", { id: eq1.itemId, decision: "approve" })).out;
if (g1.ok) fail("守卫失效:父未合入却批准成功");
if (!String(g1.error).includes("父分支")) fail(`守卫报错不符:${g1.error}`);
console.log(`  守卫 ✓(${String(g1.error).slice(0, 40)}…)`);

// 父送审 → approve → ff 合入主线
const eq2 = (await rpc("review.enqueueCommit", { workspaceId: child.workspaceId, message: "child 送审" })).out;
expectOk(eq2, "review.enqueueCommit(child)");
const g2 = (await rpc("review.decide", { id: eq2.itemId, decision: "approve" })).out;
expectOk(g2, "review.decide(child)");
if (!existsSync(join(repoDir, "c.txt"))) fail("child 合并后主线缺 c.txt");

// 主线再前进(制造分叉)→ 孙审批走 rebase onto 主线头
writeFileSync(join(repoDir, "main-only.txt"), "m");
await git(repoDir, "add", "-A");
await git(repoDir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "main advance");
const g3 = (await rpc("review.decide", { id: eq1.itemId, decision: "approve" })).out;
expectOk(g3, "review.decide(grandchild after parent)");
if (!existsSync(join(repoDir, "g.txt")) || !existsSync(join(repoDir, "main-only.txt"))) fail("grand 合并后主线文件不齐");
console.log("  合链:child → main ✓;grandchild(rebase onto 主线头)→ main ✓");

// 清理:血缘守卫(先孙后子)
const rmGrand = (await rpc("workspace.remove", { projectId: pid, workspaceId: grandchild.workspaceId })).out;
if (!rmGrand.ok) fail(`移除孙失败:${rmGrand.error}`);
const rmChild = (await rpc("workspace.remove", { projectId: pid, workspaceId: child.workspaceId })).out;
if (!rmChild.ok) fail(`移除子失败:${rmChild.error}`);
console.log("  清理:grand → child 依序移除 ✓");

/* ---- B. Router 分派回退(离线:routerModel 指向不存在的 provider) ---- */
console.log("[4] B:Router 分派回退(无效 routerModel → fallback 直执 → run 失败)…");
expectOk((await rpc("settings.set", { routerModel: "invalid-provider/invalid-model" })).out, "settings.set(routerModel)");
const saved = (await rpc("automations.save", {
	automation: {
		id: "",
		name: "e2e Router 分派",
		enabled: false,
		trigger: { kind: "daily", time: "03:00" },
		prompt: "e2e:验证 Router 分派回退链路",
		modelKey: "invalid-provider/invalid-model",
		target: { kind: "workspace", workspaceId: wsDefault },
		reuseSession: false,
		autoVerify: false,
		dispatch: "router",
		timeoutMin: 1,
		createdAt: 0,
	},
})).out;
expectOk(saved, "automations.save");
const runResp = (await rpc("automations.run", { id: saved.automation.id })).out;
expectOk(runResp, "automations.run");
const runId = runResp.runId;

let run: any = null;
for (let i = 0; i < 240; i++) {
	if (exited) fail(`daemon 中途退出 · stderr: ${stderrTail.slice(0, 400)}`);
	const runs = (await rpc("automations.runs", { id: saved.automation.id })).out;
	run = runs.runs?.find((r: any) => r.id === runId);
	if (run && ["ok", "failed", "timeout", "aborted"].includes(run.status)) break;
	await Bun.sleep(1000);
}
if (!run) fail("180s 内 run 未终态");
if (run.dispatched !== "fallback") fail(`dispatched 非 fallback:${run.dispatched}(status=${run.status})`);
if (run.status !== "failed") fail(`无效模型下直执应 failed,实为 ${run.status}:${run.error ?? ""}`);
console.log(`  run ${runId}:dispatched=fallback · status=failed(链路:Router 不可用 → 直执 → 模型错)✓`);

/* ---- C. 任务卡 + 任务经历 ---- */
console.log("[5] C:任务卡生成(automation.run → task)→ 终态 → 项目根经历落盘…");
let task: any = null;
for (let i = 0; i < 20; i++) {
	const tl = (await rpc("tasks.list", {})).out;
	task = tl.tasks?.find((t: any) => t.runId === runId);
	if (task) break;
	await Bun.sleep(500);
}
if (!task) fail("任务卡未生成");
if (task.source !== "automation") fail(`卡来源非 automation:${task.source}`);
if (task.status !== "failed") fail(`卡状态非 failed:${task.status}`);
console.log(`  卡 ${task.id}:${task.title} · ${task.status} ✓`);

const expPath = join(repoDir, ".memory", "project", "experience.md");
if (!existsSync(expPath)) fail(`任务经历未落盘:${expPath}`);
const expRaw = readFileSync(expPath, "utf8");
if (!expRaw.includes("e2e Router 分派")) fail("经历内容缺任务标题");
if (!expRaw.includes("失败")) fail("经历内容缺结论");
if (!expRaw.includes("source: task")) fail("经历 front-matter 缺 source: task");
console.log("  任务经历 → 项目根 .memory/project/experience.md ✓");

// D. task.updated 实时事件(WS)
if (!got.some((e) => e.type === "task.updated")) fail("WS 未收到 task.updated 事件");
console.log(`[6] D:WS task.updated 实时可达 ✓(共收到 ${got.length} 条事件)`);

console.log("[7] 清理…");
ws.close();
proc.kill();
await Bun.sleep(800);
rmSync(workDir, { recursive: true, force: true });

console.log("\n✅ P3 域离线验收通过:stacked 血缘+守卫+合链 / git.commitAll+送审 / Router 回退链 / 任务卡+任务经历 / WS 事件");
process.exit(0);
