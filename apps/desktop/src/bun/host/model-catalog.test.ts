/** ModelCatalog 单测:投影/去重排序/缓存 TTL/refresh 强制重拉(注入假 spawner,零 pi 进程) */

import { describe, expect, test } from "bun:test";
import { ModelCatalog, type ModelSpawner } from "./model-catalog";
import type { PiRpcClient } from "./pi-rpc-client";

function fakeClient(models: any[], calls: { n: number } = { n: 0 }): PiRpcClient {
	return {
		request: async (cmd: any) => {
			calls.n++;
			if (cmd.type === "get_available_models") return { models };
			throw new Error(`意外命令:${cmd.type}`);
		},
		dispose: async () => {},
	} as unknown as PiRpcClient;
}

const RAW = [
	{ id: "glm-5", provider: "zhipu", name: "GLM-5", reasoning: true, contextWindow: 200000, maxTokens: 16384 },
	{ id: "glm-4.6", provider: "zhipu", name: "GLM-4.6", reasoning: false },
	{ id: "claude-x", provider: "anthropic", name: "Claude X", reasoning: true },
	{ provider: "broken", name: "缺 id 应被丢弃" },
	{ id: "dup", provider: "zhipu", name: "重复 key 应去重" },
	{ id: "dup", provider: "zhipu", name: "重复 key 应去重" },
];

describe("ModelCatalog(pi 模型目录)", () => {
	test("project:投影 + key;缺 provider/id 丢弃", () => {
		expect(ModelCatalog.project(RAW[0])).toEqual({
			key: "zhipu/glm-5",
			provider: "zhipu",
			id: "glm-5",
			name: "GLM-5",
			reasoning: true,
			contextWindow: 200000,
			maxTokens: 16384,
		});
		expect(ModelCatalog.project(RAW[3])).toBeNull();
	});

	test("list:去重 + 按 provider/id 排序;坏条目过滤", async () => {
		const calls = { n: 0 };
		const cat = new ModelCatalog({ spawner: () => fakeClient(RAW, calls) });
		const models = await cat.list();
		expect(models.map((m) => m.key)).toEqual(["anthropic/claude-x", "zhipu/dup", "zhipu/glm-4.6", "zhipu/glm-5"]);
		expect(calls.n).toBe(1);
	});

	test("缓存:命中不发请求;refresh=true 强制重拉;并发去重(inflight 复用)", async () => {
		const calls = { n: 0 };
		let spawned = 0;
		const spawner: ModelSpawner = async () => {
			spawned++;
			return fakeClient(RAW, calls);
		};
		const cat = new ModelCatalog({ spawner, cacheTtlMs: 60_000 });
		await cat.list();
		await cat.list(); // 命中缓存
		expect(calls.n).toBe(1);
		expect(spawned).toBe(1);

		const [a, b] = await Promise.all([cat.list(true), cat.list(true)]); // 并发 refresh → 单次拉取
		expect(a.length).toBe(b.length);
		expect(calls.n).toBe(2);
		expect(spawned).toBe(2);
	});

	test("TTL 过期后重拉", async () => {
		const calls = { n: 0 };
		const cat = new ModelCatalog({ spawner: () => fakeClient(RAW, calls), cacheTtlMs: 10 });
		await cat.list();
		await new Promise((r) => setTimeout(r, 30));
		await cat.list();
		expect(calls.n).toBe(2);
	});
});
