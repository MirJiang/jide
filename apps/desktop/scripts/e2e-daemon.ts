/**
 * E2E:daemon 常驻宿主(不经 UI,直连 daemon)
 * 验证:spawn → health → RPC(settings/models/automations CRUD/automation.run 落历史)→
 *       WS 事件连接 + resync 回放 → 常驻存活 → 杀掉后端口文件与进程回收。
 * 用法:bun apps/desktop/scripts/e2e-daemon.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "jide-daemon-e2e-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;

const entry = join(import.meta.dir, "..", "src", "bun", "daemon.ts");
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

console.log("[1] spawn daemon(bun src/bun/daemon.ts)…");
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

const daemonDir = join(runtime, "daemon");
let port = 0;
let token = "";
let health: any = null;
for (let i = 0; i < 60; i++) {
	if (exited) fail(`daemon 提前退出(code 见下)· stderr: ${stderrTail.slice(0, 400)}`);
	if (existsSync(join(daemonDir, "port")) && existsSync(join(daemonDir, "token"))) {
		port = Number(readFileSync(join(daemonDir, "port"), "utf8").trim());
		token = readFileSync(join(daemonDir, "token"), "utf8").trim();
		try {
			const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
			if (r.ok) {
				health = await r.json();
				break;
			}
		} catch {
			/* 尚未就绪 */
		}
	}
	await Bun.sleep(500);
}
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
if (!health?.ok) fail("daemon 30s 未就绪");
console.log(`  health ok · protocol=v${health.protocol} · pid=${health.pid} · :${port}`);

async function rpc(method: string, params?: unknown): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ params: params ?? {} }),
	});
	const out = await res.json();
	return { status: res.status, out };
}

console.log("[2] RPC 冒烟(settings / models / automations CRUD)…");
expectOk((await rpc("settings.get")).out, "settings.get");
const models = (await rpc("models.list")).out;
if (!models.ok) fail(`models.list:${models.error}`);
console.log(`  models:${models.models.length} 个`);

const saved = (await rpc("automations.save", {
	automation: {
		id: "",
		name: "e2e 定时任务",
		enabled: true,
		trigger: { kind: "daily", time: "03:00" },
		prompt: "e2e 测试任务",
		modelKey: "",
		target: { kind: "workspace", workspaceId: "p:default" },
		reuseSession: false,
		autoVerify: true,
		timeoutMin: 30,
		createdAt: 0,
	},
})).out;
expectOk(saved, "automations.save");
expectOk((await rpc("automations.list")).out, "automations.list");
expectOk((await rpc("automations.runs", { id: saved.automation.id })).out, "automations.runs");
expectOk((await rpc("automations.delete", { id: saved.automation.id })).out, "automations.delete");

// 鉴权:错 token → 401
const bad = await fetch(`http://127.0.0.1:${port}/rpc/settings.get`, {
	method: "POST",
	headers: { authorization: "Bearer wrong" },
	body: "{}",
});
if (bad.status !== 401) fail(`鉴权失效:错 token 返回 ${bad.status}`);
console.log("  错 token → 401 ✓");

console.log("[3] WS 事件通道 + resync 回放…");
const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
const got: any[] = [];
let seqSeen = 0;
await new Promise<void>((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("WS 5s 未 open")), 5000);
	ws.onopen = () => {
		clearTimeout(t);
		resolve();
	};
	ws.onmessage = (m) => {
		try {
			const e = JSON.parse(String(m.data));
			got.push(e);
			if (typeof e.seq === "number" && e.seq > seqSeen) seqSeen = e.seq;
		} catch {
			/* 忽略 */
		}
	};
	ws.onerror = () => reject(new Error("WS 错误"));
});
// 触发一条事件:host.log 走 journal(经 RPC 会话类不引;用 automations.save 触发 automation.updated)
await rpc("automations.save", {
	automation: { id: "", name: "ws 触发", enabled: true, trigger: { kind: "daily", time: "04:00" }, prompt: "x", modelKey: "", target: { kind: "workspace", workspaceId: "p:default" }, reuseSession: false, autoVerify: true, timeoutMin: 30, createdAt: 0 },
});
await Bun.sleep(800);
if (!got.some((e) => e.type === "automation.updated")) fail("WS 未收到 automation.updated 事件");
// resync:从 0 回放
ws.send(JSON.stringify({ type: "resync", lastSeq: 0 }));
await Bun.sleep(800);
const replayed = got.filter((e) => e.type === "automation.updated");
if (replayed.length < 2) fail(`resync 回放不足(收到 ${replayed.length} 条 automation.updated)`);
console.log(`  实时事件 + resync 回放 ✓(${got.length} 条,最大 seq=${seqSeen})`);
ws.close();

console.log("[4] 常驻存活 + 清理…");
await Bun.sleep(1200);
if (exited) fail("daemon 意外退出");
console.log("  daemon 存活 ✓(app 关闭不退)");
proc.kill();
await Bun.sleep(800);
if (!existsSync(join(daemonDir, "pid"))) fail("pid 文件丢失");
rmSync(workDir, { recursive: true, force: true });

console.log("\n✅ daemon E2E 通过:健康/RPC 全型(含 401 鉴权)/WS 实时+回放/常驻存活/回收");
process.exit(0);

function expectOk(out: any, what: string) {
	if (!out?.ok) fail(`${what}:${out?.error ?? "非 ok 响应"}`);
}
