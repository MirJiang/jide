/**
 * TerminalManager(管道式 shell)测试:创建 → 写命令 → 收输出事件 → 退出
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostEventInput } from "@jide/contracts";
import { TerminalManager } from "./terminal-manager";

const dir = mkdtempSync(join(tmpdir(), "jide-term-test-"));

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("终端(管道式 shell)", () => {
	test("执行命令并收到输出事件;退出事件送达", async () => {
		const events: HostEventInput[] = [];
		const tm = new TerminalManager();
		tm.bindEmitter((e) => events.push(e));

		const t = tm.create("ws-test", dir);
		expect(t.id).toMatch(/^term-/);

		// 发一条命令;cmd 需要换行触发
		const w = tm.write(t.id, "echo JIDE_TERM_OK\r\n");
		expect(w.ok).toBe(true);

		// 等输出与退出
		await new Promise((r) => setTimeout(r, 1500));
		tm.write(t.id, "exit\r\n");
		await new Promise((r) => setTimeout(r, 2500));

		const outputs = events
			.filter((e): e is Extract<HostEvent, { type: "terminal.output" }> => e.type === "terminal.output")
			.map((e) => e.data)
			.join("");
		expect(outputs).toContain("JIDE_TERM_OK");
		expect(events.some((e) => e.type === "terminal.exit")).toBe(true);

		tm.disposeAll();
	}, 15000);

	test("tail:环形缓冲读到命令输出(ANSI 已剥);latestForWorkspace 取最新", async () => {
		const tm = new TerminalManager();
		const t1 = tm.create("ws-buf", dir);
		const t2 = tm.create("ws-buf", dir);
		expect(tm.latestForWorkspace("ws-buf")!.id).toBe(t2.id);
		expect(tm.latestForWorkspace("ws-none")).toBeNull();

		tm.write(t1.id, "echo JIDE_TAIL_HIT\r\n");
		await new Promise((r) => setTimeout(r, 1500));

		const r = tm.tail(t1.id, 40);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const hit = r.lines.find((l) => l.includes("JIDE_TAIL_HIT"));
			expect(hit).toBeTruthy();
			// ANSI 已剥离:行内不应有 ESC 序列
			for (const l of r.lines) expect(l.includes("\x1b")).toBe(false);
		}
		// 不存在的终端 → 明确错误
		expect(tm.tail("term-nope").ok).toBe(false);
		// 指定 t2(无输出)不误读 t1 内容
		const r2 = tm.tail(t2.id, 40);
		if (r2.ok) expect(r2.lines.join("\n")).not.toContain("JIDE_TAIL_HIT");

		tm.disposeAll();
	}, 15000);
});
