/**
 * TerminalManager(管道式 shell)测试:创建 → 写命令 → 收输出事件 → 退出
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent } from "@jide/contracts";
import { TerminalManager } from "./terminal-manager";

const dir = mkdtempSync(join(tmpdir(), "jide-term-test-"));

describe("终端(管道式 shell)", () => {
	test("执行命令并收到输出事件;退出事件送达", async () => {
		const events: HostEvent[] = [];
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
		rmSync(dir, { recursive: true, force: true });
	}, 15000);
});
