/**
 * E2E:真实本机 pi 会话链路(不经 UI,直连 AgentHost)
 * 验证:spawn 就绪 → prompt 流式事件 → 会话文件落 JIDE 目录 → rebuild 恢复 → dispose 回收。
 * 消耗一次极短的真实模型调用(用户已在计划中确认)。
 *
 * 用法:bun apps/desktop/scripts/e2e-pi-rpc.ts
 */

import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/bun/host/agent-host";
import type { HostEvent } from "@jide/contracts";

const workDir = mkdtempSync(join(tmpdir(), "jide-pi-e2e-"));
const runtime = join(workDir, "runtime");
process.env.JIDE_HOME = runtime;

const host = new AgentHost(runtime);
const events: HostEvent[] = [];
let settledWait: ((v?: unknown) => void) | null = null;

host.bindEmitter((e) => {
	events.push(e);
	if (e.type === "host.log") console.log(`  [host.${e.level}] ${e.message}`);
	if (e.type === "agent.settled") settledWait?.();
	if (e.type === "agent.text-delta") process.stdout.write(".");
});

function fail(msg: string): never {
	console.error(`\n❌ ${msg}`);
	try {
		host.disposeAll();
	} catch {
		/* 尽力回收 pi 子进程 */
	}
	console.error(`(工作目录保留供排查:${workDir})`);
	process.exit(1);
}

const waitForSettled = (ms: number) =>
	new Promise<boolean>((resolve) => {
		const t = setTimeout(() => resolve(false), ms);
		settledWait = () => {
			clearTimeout(t);
			settledWait = null;
			resolve(true);
		};
	});

// ── 1. 创建会话(spawn 本机 pi)──
console.log("[1] createSession(spawn 本机 pi --mode rpc)…");
const entry = await host.createSession({ workspacePath: workDir });
console.log(`  sessionId=${entry.sessionId.slice(0, 12)} model=${entry.modelLabel}`);
if (!entry.sessionId) fail("sessionId 为空");
if (entry.status !== "idle") fail(`初始状态=${entry.status}`);
const enc = workDir.replace(/[^a-zA-Z0-9_-]+/g, "--");
const sessionDir = join(runtime, "sessions", enc);
console.log(`  会话目录:${sessionDir}`);
if (!existsSync(sessionDir)) fail("JIDE 会话目录不存在");

// ── 2. prompt:流式 + settled ──
console.log("[2] prompt(短指令,消耗一次真实调用)…");
await host.prompt(entry.sessionId, "不要使用任何工具。只回复两个字符:ok");
const ok = await waitForSettled(120_000);
if (!ok) fail("120s 未收到 agent.settled");
console.log("");
const deltas = events.filter((e) => e.type === "agent.text-delta");
const finals = events.filter((e) => e.type === "agent.message" && e.role === "assistant");
console.log(`  deltas=${deltas.length} assistant消息=${finals.length} 状态=${entry.status}`);
if (!deltas.length || !finals.length) fail("缺少流式事件或定稿消息");
if (entry.status !== "idle") fail(`settled 后状态=${entry.status}`);
const text = finals.map((e: any) => e.text).join("");
console.log(`  模型回复:${text.slice(0, 80).replace(/\n/g, " ")}`);

// ── 3. 会话文件确认 ──
console.log("[3] 会话文件落位…");
const files = readdirSync(sessionDir);
console.log(`  目录内容:${files.join(", ") || "(空)"}`);
if (!files.some((f) => f.endsWith(".jsonl"))) fail("会话目录中没有 .jsonl 会话文件");
const homePi = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "sessions");
console.log(`  (确认 pi 自己的 ${homePi} 不应有本项目目录)`);

// ── 4. 重建:恢复历史 ──
console.log("[4] rebuild(销毁进程 → 续接会话文件)…");
const before = host.getSnapshot(entry.sessionId)!.messages.length;
const { restored } = await host.rebuild(entry.sessionId);
console.log(`  before=${before} restored=${restored}`);
if (restored < before) fail(`恢复消息数 ${restored} < 重建前 ${before}`);

// ── 5. 清理 ──
console.log("[5] disposeAll(回收 pi 子进程)…");
host.disposeAll();
await Bun.sleep(500);
const leftover = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq node.exe"]);
// 只提示,不做强校验(node 可能被其他程序占用)
console.log(`  node 进程残留检查输出已采集(${leftover.stdout.toString().includes("node.exe") ? "存在 node 进程,请人工确认" : "无 node 进程"})`);

console.log("\n✅ E2E 全部通过:真实 pi 子进程会话(创建/流式/落盘/重建/回收)");
