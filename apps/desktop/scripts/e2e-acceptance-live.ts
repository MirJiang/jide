/**
 * E2E(live,消耗少量真实模型调用):P2/P3 域验收终局
 *  A. Automations→Router 分派全链(dispatch=router):Router 常驻会话 → spawn_worker →
 *     wait 收束 → run ok → 任务卡 done → 任务经历落盘(P1.5「关 app 照跑」由 daemon 直跑本证);
 *  B. P2 整体验收:自然语言目标 → 聊天会话(Router)拆 ≤3 子任务并发分派 → 全部收束 →
 *     汇总;任务卡按轮归组成一张(done);
 *  C. P1.3 调参观测:分派耗时 / Worker 耗时 / 记忆注入预算 实测输出。
 * 前置:~/.pi 已配置可用模型(DeepSeek)。用法:bun apps/desktop/scripts/e2e-acceptance-live.ts
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "jide-accept-live-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;
const root = workDir.replace(/\\/g, "/");

execSync(`git init -q && git config user.email t@t && git config user.name t`, { cwd: workDir });
writeFileSync(join(workDir, "README.md"), "e2e\n");
execSync(`git add -A && git commit -qm init`, { cwd: workDir });

const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "bun", "daemon.ts")], {
	stdin: "ignore",
	stdout: "ignore",
	stderr: "pipe",
	env: { ...process.env, JIDE_HOME: runtime },
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

const daemonDir = join(runtime, "daemon");
let port = 0;
let token = "";
let ready = false;
for (let i = 0; i < 60; i++) {
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
			/* 未就绪 */
		}
	}
	await Bun.sleep(500);
}
if (!ready) fail("daemon 30s 未就绪");
console.log(`[1] daemon 就绪 :${port}(app 不参与,daemon 独立承载 = P1.5 关 app 照跑的结构性实证)`);

async function rpc(method: string, params?: unknown): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ params: params ?? {} }),
	});
	return res.json();
}
const opened = await rpc("project.open", { path: root });
if (!opened.ok) fail(`project.open:${opened.error}`);
await rpc("project.trust", { projectId: opened.projectId });
const wsDefault = `${opened.projectId}:default`;
const timings: Record<string, number> = {};

/* ---- A. Automations→Router 分派全链 ---- */
console.log("[2] A:automation(dispatch=router)手动运行 → Router 常驻会话委派…");
const saved = await rpc("automations.save", {
	automation: {
		id: "",
		name: "验收·Router 分派",
		enabled: false,
		trigger: { kind: "daily", time: "03:00" },
		prompt: "只回复两个字符:ok,不要使用任何其他工具",
		modelKey: "",
		target: { kind: "workspace", workspaceId: wsDefault },
		reuseSession: false,
		autoVerify: false,
		dispatch: "router",
		timeoutMin: 3,
		createdAt: 0,
	},
});
if (!saved.ok) fail(`automations.save:${saved.error}`);
const tA0 = Date.now();
const runResp = await rpc("automations.run", { id: saved.automation.id });
if (!runResp.ok) fail(`automations.run:${runResp.error}`);
let run: any = null;
while (Date.now() - tA0 < 300_000) {
	const runs = await rpc("automations.runs", { id: saved.automation.id });
	run = runs.runs?.find((r: any) => r.id === runResp.runId);
	if (run && ["ok", "failed", "timeout", "aborted"].includes(run.status)) break;
	await Bun.sleep(2000);
}
if (!run) fail("300s 内 automation run 未终态");
timings["A.automation 分派全链"] = Date.now() - tA0;
if (run.status !== "ok") fail(`run 应 ok,实为 ${run.status}:${run.error ?? ""}`);
if (run.dispatched !== "router") fail(`dispatched 应 router,实为 ${run.dispatched}`);
if (!run.workerIds?.length) fail("router 分派未产生 workerIds");
console.log(`  run ok · dispatched=router · workerIds=${run.workerIds.join(",")} · ${Math.round(timings["A.automation 分派全链"] / 1000)}s`);
console.log(`  摘要:${(run.summary ?? "").slice(0, 120)}`);

const orch1 = await rpc("orchestrator.workers");
const aWorker = orch1.workers?.find((w: any) => run.workerIds.includes(w.id));
if (!aWorker || aWorker.status !== "done") fail(`automation Worker 未 done:${JSON.stringify(orch1.workers)}`);
if (!/ok/i.test(aWorker.summary ?? "")) fail(`automation Worker 摘要不含 ok:${aWorker.summary?.slice(0, 100)}`);

let task: any = null;
for (let i = 0; i < 30; i++) {
	const tl = await rpc("tasks.list");
	task = tl.tasks?.find((t: any) => t.runId === runResp.runId);
	if (task?.status === "done") break;
	await Bun.sleep(1000);
}
if (!task) fail("automation 任务卡未生成");
if (task.status !== "done") fail(`任务卡应 done,实为 ${task.status}`);
const expPath = join(workDir, ".memory", "project", "experience.md");
if (!existsSync(expPath)) fail("任务经历未落盘(项目根)");
const expRaw = readFileSync(expPath, "utf8");
if (!expRaw.includes("验收·Router 分派")) fail("经历缺 automation 卡标题");
console.log(`  任务卡 done ✓ · 任务经历落盘(项目根 experience.md)✓`);

/* ---- B. P2 整体验收:聊天目标拆 ≤3 子任务并发分派汇总 ---- */
console.log("[3] B:聊天会话(Router)自然语言目标 → ≤3 Worker 并发分派汇总…");
const created = await rpc("session.create", { workspacePath: root });
if (!created.ok) fail(`session.create:${created.error}`);
console.log(`  session=${created.sessionId.slice(0, 8)} model=${created.modelLabel}`);
const tB0 = Date.now();
const prompted = await rpc("session.prompt", {
	sessionId: created.sessionId,
	text: "把下面这个目标拆成 2~3 个并行子任务(不要超过 3 个),用 spawn_worker 工具并发委派,每个 Worker 的任务书都是:「只回复两个字符:ok,不要使用任何其他工具」。然后用 wait_workers 等全部完成,最后用一句话汇总全部结果。除此之外不要做任何其他事。",
});
if (!prompted.ok) fail(`session.prompt:${prompted.error}`);

let workers: any[] = [];
while (Date.now() - tB0 < 300_000) {
	const r = await rpc("orchestrator.workers");
	workers = (r.workers ?? []).filter((w: any) => w.routerSessionId === created.sessionId);
	if (workers.length >= 2 && workers.every((w: any) => w.status !== "queued" && w.status !== "running")) break;
	await Bun.sleep(2000);
}
timings["B.聊天拆分并发全链"] = Date.now() - tB0;
if (workers.length < 2) fail(`拆分子任务 <2(实 ${workers.length})——Router 未按自然语言目标拆分`);
if (workers.length > 3) fail(`拆分子任务 >3(实 ${workers.length})`);
const notDone = workers.filter((w: any) => w.status !== "done");
if (notDone.length) fail(`存在未完成 Worker:${JSON.stringify(notDone.map((w: any) => ({ id: w.id, status: w.status, error: w.error })))}`);
console.log(`  ${workers.length} 路并发全部 done(${workers.map((w: any) => `${w.id}:${Math.round((w.durationMs ?? 0) / 1000)}s`).join(", ")})· ${Math.round(timings["B.聊天拆分并发全链"] / 1000)}s`);

// 任务卡:同轮归组一张,settle 后 done
let chatTask: any = null;
for (let i = 0; i < 30; i++) {
	const tl = await rpc("tasks.list");
	chatTask = tl.tasks?.find((t: any) => t.source === "chat" && t.routerSessionId === created.sessionId);
	if (chatTask?.status === "done" && chatTask.workerIds.length >= 2) break;
	await Bun.sleep(1000);
}
if (!chatTask) fail("聊天任务卡未生成");
if (chatTask.workerIds.length < 2) fail(`聊天卡 Worker 归组不全:${JSON.stringify(chatTask.workerIds)}`);
if (chatTask.status !== "done") fail(`聊天卡应 done,实为 ${chatTask.status}`);
console.log(`  任务卡归组:1 张卡 × ${chatTask.workerIds.length} Worker · done ✓(兼 Worker 面板实证)`);

/* ---- C. P1.3 调参观测 ---- */
console.log("[4] C:调参观测(实测数据)…");
const mem = await rpc("memory.status", { workspaceId: wsDefault });
if (mem.ok) {
	console.log(`  记忆注入预算:total=${mem.budget?.totalK}K / cap=${mem.budget?.capK}K(经历层=${mem.budget?.experienceK ?? "-"}K)`);
}
const expRawNow = readFileSync(expPath, "utf8"); // 现读(聊天卡在 B 段收口后写入)
const expLines = expRawNow.split("\n").filter((l) => l.startsWith("- "));
console.log(`  任务经历条数:${expLines.length}`);
for (const l of expLines) console.log(`    ${l.slice(0, 110)}`);
if (!expRawNow.includes("· chat ·")) fail(`聊天任务经历缺失(chat 来源行未写入):${expRawNow.slice(0, 300)}`);
console.log(`  耗时汇总:`);
for (const [k, v] of Object.entries(timings)) console.log(`    ${k}: ${Math.round(v / 1000)}s`);
const allWorkers = (await rpc("orchestrator.workers")).workers ?? [];
console.log(`    Worker 耗时明细:${allWorkers.map((w: any) => `${w.id}=${Math.round((w.durationMs ?? 0) / 1000)}s`).join(", ")}`);

console.log("[5] 清理…");
proc.kill();
await Bun.sleep(500);
rmSync(workDir, { recursive: true, force: true });

console.log("\n✅ P2/P3 live 验收通过:automation Router 分派全链(卡+经历)/ 自然语言拆 ≤3 子任务并发+归组收口 / 调参观测输出");
process.exit(0);
