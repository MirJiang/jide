/** 编排扩展 + 事件持久化 + autostart 单测 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAutostart } from "./autostart";
import { EventStore } from "./event-store";

/* ---------------- jide-orchestrator 扩展 ---------------- */

async function loadTools(env: Record<string, string>, cacheKey: string) {
	const saved = { ...process.env };
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	try {
		const mod = await import(`./extensions/jide-orchestrator?case=${cacheKey}`);
		const registered: any[] = [];
		mod.default({ registerTool: (t: any) => registered.push(t) });
		return registered;
	} finally {
		process.env = saved;
	}
}

describe("jide-orchestrator 扩展(委派工具)", () => {
	test("JIDE_ORCH=1:注册 5 个委派工具,execute 透传 __router", async () => {
		const registered = await loadTools(
			{ JIDE_ORCH: "1", JIDE_BRIDGE_URL: "http://127.0.0.1:1", JIDE_BRIDGE_TOKEN: "t", JIDE_WORKSPACE_ID: "p:w" },
			"on",
		);
		expect(registered.map((t) => t.name)).toEqual([
			"spawn_worker",
			"wait_workers",
			"worker_status",
			"send_to_worker",
			"stop_worker",
		]);
		let seen: any = null;
		const orig = globalThis.fetch;
		globalThis.fetch = (async (_input: any, init?: any) => {
			seen = { url: String(_input), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], details: undefined }), { status: 200 });
		}) as any;
		try {
			const out = await registered[0].execute("c", { objective: "干活的" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "router-session-1" },
			});
			expect(out.content[0].text).toBe("ok");
			expect(seen.url).toBe("http://127.0.0.1:1/tool/spawn_worker");
			expect(seen.body.params.__router).toBe("router-session-1");
			expect(seen.body.workspaceId).toBe("p:w");
		} finally {
			globalThis.fetch = orig;
		}
	});

	test("无 JIDE_ORCH:零注册(非编排会话零存在感)", async () => {
		const registered = await loadTools({}, "off");
		expect(registered.length).toBe(0);
	});
});

/* ---------------- EventStore ---------------- */

describe("EventStore(事件落盘)", () => {
	test("append/load 往返;坏行跳过;轮转 .old", () => {
		const dir = mkdtempSync(join(tmpdir(), "jide-evstore-"));
		const es = new EventStore(dir, { maxBytes: 2000, maxLoad: 100 });
		for (let i = 1; i <= 8; i++) es.append({ type: "host.log", seq: i, level: "info", message: `事件 ${i}` } as any);
		expect(es.load().length).toBe(8);
		// 第二批足够长 → 恰好触发一次轮转(.old = 前段,当前 = 后段,合计不丢)
		for (let i = 9; i <= 20; i++)
			es.append({ type: "host.log", seq: i, level: "info", message: `后续事件 ${i} —— ${"padding".repeat(30)}` } as any);
		const loaded2 = es.load();
		expect(loaded2.length).toBe(20);
		expect(existsSync(join(dir, "events.jsonl.old"))).toBe(true);
		// 坏行容错
		writeFileSync(join(dir, "events.jsonl"), "{bad json\n", "utf8");
		const es2 = new EventStore(dir, {});
		expect(es2.load().length).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true, force: true });
	});
});

/* ---------------- autostart ---------------- */

describe("autostart(注册表 Run 键)", () => {
	test("启用:reg add 指向 launcher;停用:reg delete;失败透传", () => {
		const cmds: string[][] = [];
		const runner = (cmd: string[]) => {
			cmds.push(cmd);
			return { status: 0 };
		};
		const appDir = join("X:", "app", "Resources", "app");
		const r1 = applyAutostart(true, appDir, runner);
		expect(r1.ok).toBe(true);
		expect(cmds[0][0]).toBe("reg");
		expect(cmds[0][1]).toBe("add");
		expect(cmds[0].at(-2)).toBe('"X:\\app\\bin\\launcher.exe"');
		const r2 = applyAutostart(false, appDir, runner);
		expect(r2.ok).toBe(true);
		expect(cmds[1]).toEqual(["reg", "delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "JIDE", "/f"]);
		const r3 = applyAutostart(true, appDir, () => ({ status: 1 }));
		expect(r3.ok).toBe(false);
	});
});
