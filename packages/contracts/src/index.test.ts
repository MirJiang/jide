import { describe, expect, test } from "bun:test";
import {
	PROTOCOL_VERSION,
	createEventJournal,
	isHostEvent,
	type HostEvent,
	type HostRequestShapes,
	type HostRequestMethod,
} from "./index";

describe("contracts: 协议三原则", () => {
	test("PROTOCOL_VERSION 为正整数且从 1 开始", () => {
		expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
		expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
	});

	test("可枚举:全部请求方法已知", () => {
		const methods: HostRequestMethod[] = [
			"app.hello",
			"session.create",
			"session.prompt",
			"session.abort",
			"session.rebuild",
			"session.get",
		];
		for (const m of methods) expect(typeof m).toBe("string");
		// 类型存在性编译期断言(错误形状都有 error 字段)
		type Resp = HostRequestShapes["session.prompt"]["response"];
		const r: Resp = { ok: false, error: "x" };
		expect(r.ok).toBe(false);
	});

	test("可回放:journal 分配单调 seq 并支持 since 增量读取", () => {
		const j = createEventJournal();
		expect(j.lastSeq()).toBe(0);
		const e1 = j.append({ type: "host.log", level: "info", message: "a" });
		const e2 = j.append({ type: "agent.started", sessionId: "s1" });
		expect(e1.seq).toBe(1);
		expect(e2.seq).toBe(2);
		expect(j.lastSeq()).toBe(2);
		const catchUp = j.since(1);
		expect(catchUp).toHaveLength(1);
		expect(catchUp[0].seq).toBe(2);
		expect((catchUp[0] as HostEvent).type).toBe("agent.started");
	});

	test("可回放:journal 环形裁剪不破坏 seq 单调", () => {
		const j = createEventJournal(3);
		for (let i = 0; i < 6; i++) j.append({ type: "host.log", level: "info", message: String(i) });
		expect(j.lastSeq()).toBe(6);
		const all = j.since(0);
		expect(all).toHaveLength(3);
		expect(all[0].seq).toBe(4);
		expect(all[2].seq).toBe(6);
	});

	test("守卫:isHostEvent 校验 type 与 seq", () => {
		expect(isHostEvent({ type: "host.log", seq: 1, level: "info", message: "x" })).toBe(true);
		expect(isHostEvent({ type: "nope", seq: 1 })).toBe(false);
		expect(isHostEvent({ type: "host.log" })).toBe(false);
		expect(isHostEvent(null)).toBe(false);
		expect(isHostEvent(42)).toBe(false);
	});

	test("事件可 JSON 序列化往返(wire 传输无损)", () => {
		const j = createEventJournal();
		const e = j.append({ type: "agent.text-delta", sessionId: "s", delta: "你好 π" });
		const round = JSON.parse(JSON.stringify(e));
		expect(isHostEvent(round)).toBe(true);
		expect(round.delta).toBe("你好 π");
	});
});
