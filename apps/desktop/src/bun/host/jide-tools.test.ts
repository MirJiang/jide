/** 工具桥扩展单测:注册面 + 桥调用协议 + 错误语义(假 pi + stub fetch) */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** 动态加载扩展(env 须在 import 前设置),捕获注册的工具表;query 串击穿模块缓存 */
async function loadTools(env: Record<string, string>, cacheKey = "main") {
	const saved = { ...process.env };
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	try {
		const mod = await import(`./extensions/jide-tools?case=${cacheKey}`);
		const registered: any[] = [];
		mod.default({ registerTool: (t: any) => registered.push(t) });
		return registered;
	} finally {
		process.env = saved;
	}
}

/** 临时替换全局 fetch */
function stubFetch(fn: (input: any, init?: any) => Promise<Response>): () => void {
	const orig = globalThis.fetch;
	globalThis.fetch = fn as any;
	return () => (globalThis.fetch = orig);
}

describe("jide-tools 扩展(工具桥,pi 进程内)", () => {
	let registered: any[] = [];

	beforeAll(async () => {
		registered = await loadTools({
			JIDE_BRIDGE_URL: "http://127.0.0.1:45678",
			JIDE_BRIDGE_TOKEN: "tok-abc",
			JIDE_WORKSPACE_ID: "p:w1",
		});
	});

	test("注册 10 个领域工具,名称与 schema 齐全", () => {
		const names = registered.map((t) => t.name);
		expect(names).toEqual([
			"dev_server",
			"http_probe",
			"browser",
			"test_run",
			"checks",
			"plan",
			"memory_suggest",
			"terminal_read",
			"terminal_send",
			"git_diff_files",
		]);
		for (const t of registered) {
			expect(t.description.length).toBeGreaterThan(10);
			expect(t.parameters).toBeTruthy();
			expect(typeof t.execute).toBe("function");
		}
		// promptSnippet 进系统提示词(旧 agent-tools 同款要求)
		for (const t of registered) expect(typeof t.promptSnippet).toBe("string");
	});

	test("execute → POST /tool/<name>,带 token 与 workspaceId/params", async () => {
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		let seenBody: any;
		const undo = stubFetch(async (input: any, init?: any) => {
			seenUrl = String(input);
			seenHeaders = init.headers;
			seenBody = JSON.parse(init.body);
			return new Response(
				JSON.stringify({ content: [{ type: "text", text: "ok-result" }], details: undefined }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		try {
			const dev = registered.find((t) => t.name === "dev_server")!;
			const out = await dev.execute("call-1", { action: "ensure", port: 5175 });
			expect(seenUrl).toBe("http://127.0.0.1:45678/tool/dev_server");
			expect(seenHeaders.authorization).toBe("Bearer tok-abc");
			expect(seenBody).toEqual({ workspaceId: "p:w1", params: { action: "ensure", port: 5175 } });
			expect(out.content[0].text).toBe("ok-result");
			expect(out.isError).toBeUndefined();
		} finally {
			undo();
		}
	});

	test("桥 HTTP 失败 → isError 结果(agent 可读)", async () => {
		const undo = stubFetch(async () =>
			new Response(JSON.stringify({ error: "未知工具:x" }), { status: 404 }),
		);
		try {
			const probe = registered.find((t) => t.name === "http_probe")!;
			const out = await probe.execute("c", { url: "http://x" });
			expect(out.isError).toBe(true);
			expect(out.content[0].text).toContain("HTTP 404");
			expect(out.content[0].text).toContain("未知工具");
		} finally {
			undo();
		}
	});

	test("桥不可达(网络异常)→ isError 结果", async () => {
		const undo = stubFetch(async () => {
			throw new Error("connection refused");
		});
		try {
			const t = registered.find((x) => x.name === "test_run")!;
			const out = await t.execute("c", { scope: "all" });
			expect(out.isError).toBe(true);
			expect(out.content[0].text).toContain("工具桥不可达");
		} finally {
			undo();
		}
	});

	test("未注入桥环境变量 → isError 结果(清晰提示,不静默)", async () => {
		const bare = await loadTools({}, "bare");
		const t = bare.find((x) => x.name === "git_diff_files")!;
		const out = await t.execute("c", {});
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("工具桥未接入");
	});
});
