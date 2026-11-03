/** 日志回喂泵单测:错误检测 / debounce 合并 / 节流 / 只推 busy / 轮次上限 / settled 重置 */

import { describe, expect, test } from "bun:test";
import { DevLogPump } from "./dev-log-pump";

function fakeHost(steered: number[] = [], busy = true) {
	const sessions = new Map<string, { workspaceId?: string; busy: boolean }>([
		["s-busy", { workspaceId: "p:w1", busy }],
	]);
	return {
		logs: [] as Array<{ level: string; message: string }>,
		log(level: "info" | "warn" | "error", message: string) {
			this.logs.push({ level, message });
		},
		async steerBusyForWorkspace(workspaceId: string, text: string) {
			if (!busy || !sessions.has("s-busy") || sessions.get("s-busy")!.workspaceId !== workspaceId) return 0;
			steered.push({ workspaceId, text } as any);
			return 1;
		},
		getSession(sessionId: string) {
			const s = sessions.get(sessionId);
			return s ? { workspaceId: s.workspaceId } : undefined;
		},
		hasSessionForWorkspace(workspaceId: string) {
			return workspaceId === "p:w1";
		},
		hasBusySessionForWorkspace(workspaceId: string) {
			return workspaceId === "p:w1" && sessions.has("s-busy");
		},
	};
}

const FAST = { debounceMs: 20, minIntervalMs: 50, maxPushesPerTurn: 2, maxBufferLines: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DevLogPump(宿主推送式日志回喂)", () => {
	test("非错误行不入队;错误行 debounce 合并为一推送", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered);
		const pump = new DevLogPump(host, FAST);
		pump.onLine("p:w1", "vite ready in 300ms");
		pump.onLine("p:w1", "[vite] Internal server error: Cannot read /x.ts");
		pump.onLine("p:w1", "  at Object.render (x.ts:1:1)");
		await sleep(120);
		expect(steered.length).toBe(1);
		expect(steered[0].text).toContain("Internal server error");
		expect(steered[0].text).not.toContain("vite ready"); // 非错误行不进缓冲
		pump.dispose();
	});

	test("空闲会话不插队,仅 host.log 提示", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered, false);
		const pump = new DevLogPump(host, FAST);
		pump.onLine("p:w1", "Error: EADDRINUSE :5175");
		await sleep(120);
		expect(steered.length).toBe(0);
		expect(host.logs.some((l) => l.message.includes("未自动插队"))).toBe(true);
		pump.dispose();
	});

	test("最小间隔节流:冷却期行保留,不丢", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered);
		const pump = new DevLogPump(host, { debounceMs: 20, minIntervalMs: 300 });
		pump.onLine("p:w1", "error A");
		await sleep(100); // t≈20 已推送 #1
		expect(steered.length).toBe(1);
		pump.onLine("p:w1", "error B"); // t=100:debounce 到点时距上次仅 ~100ms < 300 → 冷却
		await sleep(100); // t=200:仍在冷却,缓冲保留
		expect(steered.length).toBe(1);
		await sleep(300); // t≈320:冷却过,重试成功
		expect(steered.length).toBe(2);
		expect(steered[1].text).toContain("error B");
		pump.dispose();
	});

	test("每轮上限:超出降级 host.log;agent.settled 重置计数", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered);
		const pump = new DevLogPump(host, { debounceMs: 20, minIntervalMs: 0, maxPushesPerTurn: 2 });
		pump.bindEmitter(() => {});
		pump.onLine("p:w1", "error 1");
		await sleep(80);
		pump.onLine("p:w1", "error 2");
		await sleep(80);
		pump.onLine("p:w1", "error 3");
		await sleep(80);
		expect(steered.length).toBe(2); // maxPushesPerTurn=2
		expect(host.logs.some((l) => l.message.includes("降级为日志"))).toBe(true);
		// settled → 重置
		pump.handleHostEvent({ type: "agent.settled", sessionId: "s-busy" });
		pump.onLine("p:w1", "error 4");
		await sleep(80);
		expect(steered.length).toBe(3);
		pump.dispose();
	});

	test("缓冲上限:超过 maxBufferLines 丢最旧", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered);
		const pump = new DevLogPump(host, { ...FAST, debounceMs: 60, maxBufferLines: 3 });
		for (let i = 1; i <= 5; i++) pump.onLine("p:w1", `error line-${i}`);
		await sleep(160);
		expect(steered.length).toBe(1);
		expect(steered[0].text).toContain("line-5");
		expect(steered[0].text).not.toContain("line-1"); // 最旧的被挤掉
		expect(steered[0].text).not.toContain("line-2");
		pump.dispose();
	});

	test("无会话的工作区:既不插队也不提示", async () => {
		const steered: any[] = [];
		const host = fakeHost(steered);
		const pump = new DevLogPump(host, FAST);
		pump.onLine("p:other", "error x");
		await sleep(120);
		expect(steered.length).toBe(0);
		expect(host.logs.filter((l) => l.message.includes("dev server")).length).toBe(0);
		pump.dispose();
	});
});
