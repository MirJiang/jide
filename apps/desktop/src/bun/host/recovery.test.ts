/** J:进程树回收用例(风险 R4 / §6 spike#3)—— taskkill /T 树杀验证 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";

function bunPids(): number[] {
	try {
		const out = execSync('tasklist /FI "IMAGENAME eq bun.exe" /FO CSV', { encoding: "utf8" });
		return [...out.matchAll(/"bun\.exe","(\d+)"/g)].map((m) => Number(m[1]));
	} catch {
		return [];
	}
}

describe("进程树回收(R4/spike#3)", () => {
	test("taskkill /T:派生链子进程(bun sleep)被一并回收", async () => {
		const self = process.pid;
		// 直接派生 bun 子进程(与 dev server 派生链同构;用 execPath 保证可执行)
		const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		await new Promise((r) => setTimeout(r, 2000));
		const before = bunPids().filter((p) => p !== self);
		expect(before).toContain(child.pid);

		// 树杀(与 TerminalManager/DevServerManager.dispose 同语义)
		const killer = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(child.pid)], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await killer.exited;
		await new Promise((r) => setTimeout(r, 1200));

		const after = bunPids().filter((p) => p !== self);
		expect(after).not.toContain(child.pid);
	}, 20000);
});
