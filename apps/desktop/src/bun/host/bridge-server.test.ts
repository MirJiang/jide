/** 工具桥服务端单测:token 鉴权 / 路由 / 结果与错误语义 */

import { afterAll, describe, expect, test } from "bun:test";
import { ToolBridgeServer, type BridgeToolResult } from "./bridge-server";

let url = "";
const token = ToolBridgeServer.prototype.token; // 仅占位,实际用实例 token

describe("ToolBridgeServer", () => {
	const bridge = new ToolBridgeServer();

	afterAll(() => {
		bridge.stop();
	});

	test("未注册处理器:start 返回 null(不启动空服务)", async () => {
		expect(await bridge.start()).toBeNull();
		expect(bridge.running).toBe(false);
	});

	test("启动:随机端口 + start 幂等", async () => {
		bridge.register("echo", async () => ({ content: [{ type: "text", text: "hi" }] }));
		const ep1 = await bridge.start();
		expect(ep1).not.toBeNull();
		expect(ep1!.url.startsWith("http://127.0.0.1:")).toBe(true);
		expect(ep1!.url.endsWith(":0")).toBe(false); // 真端口(Node listen 异步,onListen 后可用)
		const ep2 = await bridge.start();
		expect(ep2!.url).toBe(ep1!.url);
		url = ep1!.url;
	});

	test("无 token / 错 token → 401", async () => {
		const noAuth = await fetch(`${url}/tool/echo`, { method: "POST", body: "{}" });
		expect(noAuth.status).toBe(401);
		const badAuth = await fetch(`${url}/tool/echo`, {
			method: "POST",
			headers: { authorization: "Bearer wrong" },
			body: "{}",
		});
		expect(badAuth.status).toBe(401);
	});

	test("未知工具 → 404;GET → 405;坏路径 → 404", async () => {
		const r404 = await fetch(`${url}/tool/nope`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: "{}",
		});
		expect(r404.status).toBe(404);
		const r405 = await fetch(`${url}/tool/echo`, { headers: { authorization: `Bearer ${bridge.token}` } });
		expect(r405.status).toBe(405);
		const rPath = await fetch(`${url}/other`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: "{}",
		});
		expect(rPath.status).toBe(404);
	});

	test("调用:按 workspaceId 路由参数,返回处理器结果", async () => {
		let seenWid = "";
		let seenParams: any;
		bridge.register("greet", async (wid, params) => {
			seenWid = wid;
			seenParams = params;
			return { content: [{ type: "text", text: `hi ${params.name}` }], details: { wid } };
		});
		const res = await fetch(`${url}/tool/greet`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: "p:w1", params: { name: "jide" } }),
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as BridgeToolResult;
		expect(out.content[0].text).toBe("hi jide");
		expect(out.details).toEqual({ wid: "p:w1" });
		expect(seenWid).toBe("p:w1");
		expect(seenParams).toEqual({ name: "jide" });
	});

	test("缺 workspaceId:params 兜底 / 交处理器返回可读错误;坏 JSON → 400", async () => {
		// params.workspaceId 兜底(常驻 Router 无自身工作区,靠模型显式传参定目标)
		bridge.register("wid_echo", async (wid) => ({ content: [{ type: "text", text: `wid=${wid}` }] }));
		const viaParams = await fetch(`${url}/tool/wid_echo`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: JSON.stringify({ params: { workspaceId: "p:from-params" } }),
		});
		expect(viaParams.status).toBe(200);
		expect(((await viaParams.json()) as BridgeToolResult).content[0].text).toBe("wid=p:from-params");
		// 完全缺 workspaceId → 仍调处理器(空串),由处理器返回可读错误而非协议 400
		const noWid = await fetch(`${url}/tool/wid_echo`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: JSON.stringify({ params: {} }),
		});
		expect(noWid.status).toBe(200);
		expect(((await noWid.json()) as BridgeToolResult).content[0].text).toBe("wid=");
		const badJson = await fetch(`${url}/tool/greet`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: "not-json",
		});
		expect(badJson.status).toBe(400);
	});

	test("处理器抛异常 → 200 + isError 结果(agent 可读错误文本)", async () => {
		bridge.register("boom", async () => {
			throw new Error("服务炸了");
		});
		const res = await fetch(`${url}/tool/boom`, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}` },
			body: JSON.stringify({ workspaceId: "p:w1", params: {} }),
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as BridgeToolResult;
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("服务炸了");
	});

	test("stop 后端口关闭", async () => {
		bridge.stop();
		expect(bridge.running).toBe(false);
		try {
			await fetch(`${url}/tool/echo`, { method: "POST", body: "{}", signal: AbortSignal.timeout(1500) });
			// Windows 上连接可能已被拒绝 → 上面抛错;若未抛,服务残留也算失败
			expect.unreachable();
		} catch {
			// 预期:连接失败
		}
	});
});
