/** 模型配置链路单测:AgentHost.setModel(demo 拒绝/真引擎更新 label) + ModelCatalog 之外的 args 拼装 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "./agent-host";
import { parseModelKey } from "@jide/contracts";

describe("模型切换(AgentHost.setModel)", () => {
	test("真引擎:调 setModel、更新 modelLabel 与 entry.model", async () => {
		const host = new AgentHost(join(mkdtempSync(join(tmpdir(), "jide-model-")), "rt"));
		const calls: any[] = [];
		const fakeEngine: any = {
			onEvent: () => () => {},
			setModel: async (provider: string, modelId: string) => {
				calls.push({ provider, modelId });
				return "GLM-5(测试)";
			},
		};
		(host as any).sessions.set("s1", {
			sessionId: "s1",
			engine: fakeEngine,
			sessionFilePath: "",
			cwd: "/x",
			modelLabel: "旧",
			status: "idle",
			unsubscribe: () => {},
		});

		const label = await host.setModel("s1", "zhipu", "glm-5");
		expect(label).toBe("GLM-5(测试)");
		expect(calls).toEqual([{ provider: "zhipu", modelId: "glm-5" }]);
		const entry = host.getSession("s1")!;
		expect(entry.modelLabel).toBe("GLM-5(测试)");
		expect(entry.model).toEqual({ provider: "zhipu", modelId: "glm-5" });
		host.disposeAll();
	});

	test("demo 引擎(无 setModel)→ 明确报错;会话不存在 → 报错", async () => {
		const host = new AgentHost(join(mkdtempSync(join(tmpdir(), "jide-model2-")), "rt"));
		(host as any).sessions.set("s-demo", {
			sessionId: "s-demo",
			engine: { onEvent: () => () => {} },
			sessionFilePath: "",
			cwd: "/x",
			modelLabel: "faux",
			status: "idle",
			unsubscribe: () => {},
		});
		expect(host.setModel("s-demo", "p", "m")).rejects.toThrow("不支持切换模型");
		expect(host.setModel("nope", "p", "m")).rejects.toThrow("会话不存在");
	});

	test("parseModelKey:key 往返与非法拒绝", () => {
		expect(parseModelKey("zhipu/glm-5")).toEqual({ provider: "zhipu", modelId: "glm-5" });
		expect(parseModelKey("openai/o/gpt")).toEqual({ provider: "openai", modelId: "o/gpt" });
		expect(parseModelKey("no-slash")).toBeNull();
		expect(parseModelKey("/leading")).toBeNull();
		expect(parseModelKey("trailing/")).toBeNull();
	});
});
