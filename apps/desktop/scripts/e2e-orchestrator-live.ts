/**
 * E2E(live,消耗少量真实模型调用):编排全链(P2 核心)
 * 真 daemon 进程 → RPC 建编排会话(Router)→ prompt 诱导委派 → spawn_worker →
 * Worker 独立会话执行 → wait_workers 收束 → Router 汇总;断言 Worker 记录与结果。
 * 前置:~/.pi 已配置可用模型(DeepSeek)。
 * 用法:bun apps/desktop/scripts/e2e-orchestrator-live.ts
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "jide-orch-live-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;
const root = workDir.replace(/\\/g, "/");

// 真实 git 仓库(Worker 的目标工作区)
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
console.log(`[1] daemon 就绪 :${port}`);

async function rpc(method: string, params?: unknown): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ params: params ?? {} }),
	});
	return res.json();
}

console.log("[2] 开项目 + 建编排会话(Router)…");
const opened = await rpc("project.open", { path: root });
if (!opened.ok) fail(`project.open:${opened.error}`);
await rpc("project.trust", { projectId: opened.projectId });
const created = await rpc("session.create", { workspacePath: root });
if (!created.ok) fail(`session.create:${created.error}`);
console.log(`  session=${created.sessionId.slice(0, 8)} model=${created.modelLabel}`);

console.log("[3] prompt:诱导 Router 委派 + 收结果(2-4 次真实调用)…");
const prompted = await rpc("session.prompt", {
	sessionId: created.sessionId,
	text: "请用 spawn_worker 工具委派一个 Worker,任务书:「只回复两个字符:ok,不要使用任何其他工具」。然后用 wait_workers 等它完成,最后只回复 Worker 的结果摘要。",
});
if (!prompted.ok) fail(`session.prompt:${prompted.error}`);

console.log("[4] 轮询 orchestrator.workers 直到 Worker 收束(上限 240s)…");
let workers: any[] = [];
const t0 = Date.now();
while (Date.now() - t0 < 240_000) {
	const r = await rpc("orchestrator.workers");
	if (!r.ok) fail(`orchestrator.workers:${r.error}`);
	workers = r.workers;
	if (workers.length && workers.every((w: any) => w.status !== "queued" && w.status !== "running")) break;
	await Bun.sleep(1500);
}
if (!workers.length) fail("Router 没有委派任何 Worker(240s)");
console.log(`  workers:${workers.map((w: any) => `${w.id}:${w.status}`).join(", ")}`);
const done = workers.find((w: any) => w.status === "done");
if (!done) fail(`Worker 未完成:${JSON.stringify(workers.map((w: any) => ({ status: w.status, error: w.error })))}`);
if (!/ok/i.test(done.summary ?? "")) fail(`Worker 摘要不含 ok:${done.summary?.slice(0, 120)}`);
console.log(`  Worker ${done.id} 摘要:${done.summary?.slice(0, 60)}`);

console.log("[5] 清理…");
proc.kill();
await Bun.sleep(500);
rmSync(workDir, { recursive: true, force: true });

console.log("\n✅ 编排全链通过:Router 委派 → Worker 池 → 独立执行 → wait_workers 收束 → 摘要回喂");
process.exit(0);
