/**
 * AgentHost 全链路测试(bun test,headless)
 * M1 验收:会话创建 → prompt 流式事件 → 中断 → 重建恢复。
 * 使用 faux provider(dg-piagent H03),无网络、无密钥。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostEventInput } from "@jide/contracts";
import { AgentHost } from "./agent-host";

const events: HostEventInput[] = [];
const host = new AgentHost();
host.bindEmitter((e) => events.push(e));

const workDir = mkdtempSync(join(tmpdir(), "jide-host-test-"));
process.env.JIDE_HOME = join(workDir, "runtime");

afterAll(() => {
	host.disposeAll();
	rmSync(workDir, { recursive: true, force: true });
});

const of = (type: HostEvent["type"]) => events.filter((e) => e.type === type);
const seqMonotonic = () => {
	let last = 0;
	for (const e of events) {
		const seq = (e as HostEvent).seq;
		if (seq <= last) return false;
		last = seq;
	}
	return true;
};

describe("M1 全链路:faux provider", () => {
	let sessionId = "";

	test("创建会话:事件流就绪,状态 idle", async () => {
		const entry = await host.createSession({ workspacePath: workDir, demoMode: true });
		sessionId = entry.sessionId;
		expect(sessionId.length).toBeGreaterThan(0);
		expect(of("session.created")).toHaveLength(1);
		expect(entry.status).toBe("idle");
	});

	test("prompt → 流式 delta → assistant 消息定稿 → settled", async () => {
		await host.prompt(sessionId, "你好,演示一下");
		const deltas = of("agent.text-delta");
		const finals = of("agent.message").filter((e) => (e as { role?: string }).role === "assistant");
		expect(deltas.length).toBeGreaterThan(0);
		expect(finals.length).toBeGreaterThanOrEqual(1);
		const settled = of("agent.settled");
		expect(settled.length).toBeGreaterThanOrEqual(1);
		// delta 拼接应被定稿消息覆盖(首条 demo 文案)
		const joined = deltas.map((e: any) => e.delta).join("");
		expect(joined.length).toBeGreaterThan(0);
	});

	test("快照:消息历史可读", () => {
		const snap = host.getSnapshot(sessionId)!;
		expect(snap.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
		expect(snap.messages[0].role).toBe("user");
	});

	test("中断:abort 后状态回落且不抛错", async () => {
		// faux 已消费完队列;abort 在 idle 时也应是安全幂等的
		await host.abort(sessionId);
		const entry = host.getSession(sessionId)!;
		expect(["aborted", "idle"]).toContain(entry.status);
	});

	test("重建:从会话文件恢复历史", async () => {
		const before = host.getSnapshot(sessionId)!.messages.length;
		const { entry, restored } = await host.rebuild(sessionId);
		expect(restored).toBeGreaterThanOrEqual(before);
		expect(entry.sessionId.length).toBeGreaterThan(0);
		expect(of("session.rebuilt")).toHaveLength(1);
		// 重建后能继续对话
		events.length = 0;
		await host.prompt(entry.sessionId, "再来一句");
		expect(of("agent.settled").length).toBeGreaterThanOrEqual(1);
	});

	test("事件流 seq 全程单调(可回放原则)", () => {
		expect(seqMonotonic()).toBe(true);
	});
});
