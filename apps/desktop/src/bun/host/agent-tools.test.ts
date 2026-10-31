/**
 * agent 工具整合验收测试(business-design §4 验收故事 1 的 headless 版):
 * faux 预设 toolUse → agent 真实调用 jide.http_probe / jide.git_diff_files 工具
 * → 工具执行真实服务 → 结果回传 agent → agent 总结。
 * 这证明"agent 自己测"的链路(自测闭环的 agent 驱动面)。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { buildJideTools, type ToolContext } from "./agent-tools";

const root = mkdtempSync(join(tmpdir(), "jide-tools-test-"));
mkdirSync(join(root, "proj"), { recursive: true });

let server: any;
const PORT = 19801;
const probeCalls: string[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: PORT,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const u = new URL(req.url);
			if (u.pathname === "/api/total") return Response.json({ total: { yuan: "89.70" } });
			return new Response("OK");
		},
	});
});

afterAll(() => {
	server?.stop(true);
	rmSync(root, { recursive: true, force: true });
});

const ctx: ToolContext = {
	workspaceId: "ws-test",
	cwd: join(root, "proj"),
	devserver: {
		ensure: async () => ({ ok: true, url: `http://127.0.0.1:${PORT}`, port: PORT, probeMode: "http", startedMs: 5 }),
		stop: async () => ({ ok: true }),
		status: () => ({ ok: true, state: "ready", url: `http://127.0.0.1:${PORT}`, probeMode: "http" }),
	},
	probe: async (url, expect) => {
		probeCalls.push(url);
		// 真实探测(复用 HttpProbe 语义)
		const res = await fetch(url);
		const body = await res.text();
		if (expect.jsonPath) {
			let v: any = JSON.parse(body);
			for (const seg of expect.jsonPath.split(".")) v = v?.[seg];
			return { ok: true, passed: String(v) === expect.jsonEquals, actual: String(v) };
		}
		return { ok: true, passed: res.status === (expect.expectStatus ?? 200), actual: `HTTP ${res.status}` };
	},
	testRunner: {
		run: async () => ({ ok: true, selected: 1, total: 2, durationMs: 3, results: [{ name: "整数计算", file: "cart.test.ts", status: "pass", durationMs: 1 }] }),
	},
	scanTests: () => ["cart.test.ts", "user.test.ts"],
	changedFiles: async () => ["cart.ts"],
	browsers: {
		navigate: async () => ({ ok: true, title: "青竹小铺" }),
		click: async () => ({ ok: true }),
		fill: async () => ({ ok: true }),
		capture: async () => ({ ok: true, dataBase64: Buffer.from("png").toString("base64"), path: join(root, "shot.png") }),
	},
	checks: {
		run: async () => ({ ok: true, results: [{ id: "c1", title: "总额 89.70", passed: true }] }),
		create: () => ({ ok: true, id: "chk-1" }),
	},
	plans: {
		create: () => "plan-1",
		stepDone: async () => ({ ok: true, commit: { sha: "abc1234", message: "Agent · 计划步骤 1" } }),
		current: () => "plan-1",
	},
	memory: {
		suggest: () => ({ id: "mem-1" }),
	},
};

describe("验收故事 1(headless):agent 驱动的自测闭环", () => {
	test("agent 调用 jide.http_probe → 真实探测 → 结果回传 → 总结文本", async () => {
		const faux = registerFauxProvider({ tokensPerSecond: 500 });
		faux.setResponses([
			fauxAssistantMessage([
				fauxText("我先探测接口,确认总额展示。"),
				fauxToolCall("http_probe", { url: `http://127.0.0.1:${PORT}/api/total`, jsonPath: "total.yuan", jsonEquals: "89.70" }),
			]),
			fauxAssistantMessage("接口验证通过:total.yuan = 89.70,与修复预期一致。"),
		]);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider(faux.models[0].provider, {
			baseUrl: faux.models[0].baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((m) => ({
				id: m.id, name: m.name, api: m.api, reasoning: m.reasoning, input: m.input,
				cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl,
			})),
		} as any);

		const tools = buildJideTools(ctx);
		const toolNames = (tools as any[]).map((t) => t.name);
		expect(toolNames).toContain("http_probe");
		expect(toolNames).toContain("dev_server");
		expect(toolNames).toContain("browser");
		expect(toolNames).toContain("test_run");
		expect(toolNames).toContain("checks");
		expect(toolNames).toContain("plan");
		expect(toolNames).toContain("memory_suggest");
		expect(toolNames).toContain("git_diff_files");

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			sessionManager: SessionManager.inMemory(),
			model: faux.getModel(),
			modelRuntime,
			customTools: tools as any,
			tools: ["read", "http_probe", "dev_server", "browser", "test_run", "checks", "plan", "memory_suggest", "git_diff_files"],
		});

		const toolEvents: Array<{ name: string; result?: string }> = [];
		let finalText = "";
		session.subscribe((ev: any) => {
			if (ev.type === "tool_execution_end") {
				toolEvents.push({ name: ev.toolName, result: JSON.stringify(ev.result ?? "").slice(0, 200) });
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const text = (ev.message.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
				if (text) finalText = text;
			}
		});

		await session.prompt("验证购物车总额修复");
		session.dispose();
		faux.unregister();

		// 工具被真实执行(probe 打到了本地服务)
		expect(probeCalls).toContain(`http://127.0.0.1:${PORT}/api/total`);
		const probeEv = toolEvents.find((t) => t.name === "http_probe");
		expect(probeEv).toBeDefined();
		expect(probeEv!.result).toContain("passed");
		// agent 拿到结果并总结
		expect(finalText).toContain("89.70");
	}, 30000);
});

