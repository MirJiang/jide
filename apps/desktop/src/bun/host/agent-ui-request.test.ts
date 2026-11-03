/**
 * 扩展 UI 请求链路单测(③):pi RPC extension_ui_request → EngineEvent →
 * HostEvent agent.ui.request → session.respondUI 回写。不 spawn pi:
 * 假引擎走 AgentHost 真实翻译层;PiSession.dispatch / respondUI 以运行时对象直测。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostEventInput } from "@jide/contracts";
import { AgentHost } from "./agent-host";
import { PiSession } from "./pi-session";

describe("extension_ui_request → UI 链路", () => {
	test("AgentHost 翻译:extension_ui_request → agent.ui.request(dialog 全字段)", () => {
		const host = new AgentHost(join(mkdtempSync(join(tmpdir(), "jide-ui-req-")), "rt"));
		const events: HostEventInput[] = [];
		host.bindEmitter((e) => events.push(e));

		let handler: ((e: any) => void) | null = null;
		const fakeEngine = {
			onEvent: (cb: (e: any) => void) => {
				handler = cb;
				return () => {};
			},
		};
		const entry: any = {
			sessionId: "s-ui",
			engine: fakeEngine,
			sessionFilePath: "",
			cwd: "/x",
			modelLabel: "t",
			status: "idle",
			unsubscribe: () => {},
		};
		(host as any).wireEvents(entry);

		// PiSession 透传时把 pi 原始 record 包在 .request 里(wireEvents 以此为契约)
		handler!({
			type: "extension_ui_request",
			request: { id: "u-1", method: "confirm", title: "允许危险命令?", message: "rm -rf build", timeout: 10000 },
		});
		handler!({
			type: "extension_ui_request",
			request: { id: "u-2", method: "select", title: "选一个", options: ["A", "B"] },
		});
		handler!({ type: "extension_ui_request", request: { id: "u-3", method: "notify", message: "搞定", notifyType: "warning" } });

		const ui = events.filter((e) => e.type === "agent.ui.request") as any[];
		expect(ui.length).toBe(3);
		expect(ui[0]).toMatchObject({ sessionId: "s-ui", requestId: "u-1", method: "confirm", title: "允许危险命令?", message: "rm -rf build", timeout: 10000 });
		expect(ui[1].options).toEqual(["A", "B"]);
		expect(ui[2].notifyType).toBe("warning");
		host.disposeAll();
	});

	test("AgentHost.respondUI:调引擎 respondUI;demo 引擎(无该方法)静默跳过", () => {
		const host = new AgentHost(join(mkdtempSync(join(tmpdir(), "jide-ui-resp-")), "rt"));
		const got: any[] = [];
		const fakeEngine: any = {
			onEvent: () => () => {},
			respondUI: (r: any) => got.push(r),
		};
		const entry: any = {
			sessionId: "s-ui",
			engine: fakeEngine,
			sessionFilePath: "",
			cwd: "/x",
			modelLabel: "t",
			status: "idle",
			unsubscribe: () => {},
		};
		host.getSession; // 方法存在性冒烟
		(host as any).sessions.set("s-ui", entry);

		host.respondUI("s-ui", { requestId: "u-1", confirmed: true });
		expect(got).toEqual([{ requestId: "u-1", confirmed: true }]);

		// demo 引擎无 respondUI → 不抛
		entry.engine = { onEvent: () => () => {} };
		expect(() => host.respondUI("s-ui", { requestId: "u-2", cancelled: true })).not.toThrow();

		// 会话不存在 → 抛
		expect(() => host.respondUI("nope", { requestId: "u" })).toThrow("会话不存在");
	});

	test("PiSession.dispatch:extension_ui_request 透传为 EngineEvent;respondUI 组包 extension_ui_response", () => {
		const s = new (PiSession as any)({ cwd: "/x", sessionDir: "/tmp" });
		const seen: any[] = [];
		s.onEvent((e: any) => seen.push(e));

		s.dispatch({ type: "extension_ui_request", id: "u-9", method: "input", title: "输入" });
		expect(seen).toEqual([
			{ type: "extension_ui_request", request: { type: "extension_ui_request", id: "u-9", method: "input", title: "输入" } },
		]);
		// 非 UI 事件不受影响
		s.dispatch({ type: "agent_start" });
		expect(seen[1].type).toBe("agent_start");

		// respondUI 组包:经 client.respondExtensionUI 写出(假 client 捕获)
		const written: any[] = [];
		s.client = { respondExtensionUI: (p: any) => written.push(p) };
		s.respondUI({ requestId: "u-9", value: "答案" });
		s.respondUI({ requestId: "u-8", confirmed: false });
		s.respondUI({ requestId: "u-7", cancelled: true });
		expect(written).toEqual([
			{ type: "extension_ui_response", id: "u-9", value: "答案" },
			{ type: "extension_ui_response", id: "u-8", confirmed: false },
			{ type: "extension_ui_response", id: "u-7", cancelled: true },
		]);
		// client 为空(进程退出)→ 静默
		s.client = null;
		expect(() => s.respondUI({ requestId: "u", value: "x" })).not.toThrow();
	});
});
