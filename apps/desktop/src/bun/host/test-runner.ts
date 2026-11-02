/**
 * HttpProbe + TestRunner — 测试域 4B/4D(business-design §4)
 *
 * HttpProbe:URL + 期望(状态码 / 包含文本 / JSON 路径)。
 *   失败语义:断言失败 ≠ 工具失败(passed=false 仍 ok:true)。
 * TestRunner:diff 智能选测 —— git diff 文件集映射关联用例:
 *   规则1 同名测试文件(src/cart.ts → src/cart.test.ts / __tests__/cart.test.ts)
 *   规则2 目录就近(*.test.* 同目录扫)
 *   规则3 appliesTo 模式(检查项资产声明的关联)
 *   子集失败时由调用方决定升级全量(响应里带 selected/total)。
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "../../runtime";

export namespace HttpProbe {
	export interface Expect {
		expectStatus?: number;
		contains?: string;
		jsonPath?: string;
		jsonEquals?: string;
	}
	export async function run(
		url: string,
		expect: Expect,
	): Promise<{ ok: true; passed: boolean; actual: string; detail?: string } | { ok: false; error: string }> {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
			const actualStatus = res.status;
			if (expect.expectStatus !== undefined && actualStatus !== expect.expectStatus) {
				return { ok: true, passed: false, actual: `HTTP ${actualStatus}`, detail: `期望状态码 ${expect.expectStatus}` };
			}
			const body = await res.text();
			if (expect.contains !== undefined && !body.includes(expect.contains)) {
				return {
					ok: true,
					passed: false,
					actual: body.slice(0, 200),
					detail: `期望包含 "${expect.contains}"`,
				};
			}
			if (expect.jsonPath) {
				let v: unknown;
				try {
					v = JSON.parse(body);
					for (const seg of expect.jsonPath.split(".")) {
						v = (v as any)?.[seg];
					}
				} catch {
					return { ok: true, passed: false, actual: body.slice(0, 200), detail: "响应不是 JSON" };
				}
				const actual = v === undefined ? "undefined" : String(v);
				if (expect.jsonEquals !== undefined && actual !== expect.jsonEquals) {
					return { ok: true, passed: false, actual, detail: `期望 ${expect.jsonPath}=${expect.jsonEquals}` };
				}
				return { ok: true, passed: true, actual };
			}
			return { ok: true, passed: true, actual: `HTTP ${actualStatus}` };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	}
}

export interface TestCase {
	name: string;
	file: string;
}

export interface TestOutcome {
	name: string;
	file: string;
	status: "pass" | "fail" | "skip";
	durationMs: number;
	message?: string;
}

/** 关联映射:变更文件 → 测试文件(直接匹配 + __tests__ 同名;宽匹配交给 appliesTo) */
export function mapFilesToTests(changedFiles: string[], allTestFiles: string[]): string[] {
	const hit = new Set<string>();
	for (const f of changedFiles) {
		const base = f.replace(/\.[^.]+$/, "");
		const name = base.slice(base.lastIndexOf("/") + 1);
		const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
		for (const t of allTestFiles) {
			const tBase = t.replace(/\.[^.]+$/, "");
			const tName = tBase.slice(tBase.lastIndexOf("/") + 1);
			// 直接:src/cart.ts → src/cart.test.ts / cart.spec.ts / cart_test.ts
			const direct =
				tBase === `${dir}/${name}.test` ||
				tBase === `${dir}/${name}.spec` ||
				tBase === `${dir}/${name}_test` ||
				tBase === `${dir}/${name}` ||
				(dir === "" && (tBase === `${name}.test` || tBase === `${name}.spec`));
			// __tests__:任意位置 __tests__/cart.test.ts
			const testsDir = t.includes("__tests__") && (tName === `${name}.test` || tName === `${name}.spec`);
			if (direct || testsDir) hit.add(t);
		}
	}
	return [...hit];
}

export class TestRunner {
	/**
	 * 运行选中测试。M3 通用执行器:bun test(或项目自带 runner)。
	 * 用例级结果:解析 runner 输出;无解析器的场景退化为按文件级。
	 */
	async run(
		cwd: string,
		testFiles: string[],
		totalTests: number,
	): Promise<{ ok: boolean; selected: number; total: number; durationMs: number; results: TestOutcome[] }> {
		const started = Date.now();
		if (testFiles.length === 0) {
			return { ok: true, selected: 0, total: totalTests, durationMs: 0, results: [] };
		}
		const junitFile = join(cwd, ".jide-test-report.xml");
		const proc = spawn(
			["bun", "test", ...testFiles, "--reporter=junit", `--reporter-outfile=${junitFile}`],
			{
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, FORCE_COLOR: "0" },
			},
		);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		const durationMs = Date.now() - started;
		let xml = "";
		try {
			xml = readFileSync(junitFile, "utf8");
			rmSync(junitFile, { force: true });
		} catch {
			/* junit 未生成,走控制台解析 */
		}
		const results = parseJunit(xml) ?? parseConsole(out + "\n" + err, testFiles);
		return { ok: true, selected: testFiles.length, total: totalTests, durationMs, results };
	}
}

/** bun test --reporter=junit 解析 */
function parseJunit(xml: string): TestOutcome[] | null {
	if (!xml.includes("<testsuite")) return null;
	const results: TestOutcome[] = [];
	const cases = xml.match(/<testcase[^>]*(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
	for (const c of cases) {
		const name = c.match(/name="([^"]+)"/)?.[1] ?? "unknown";
		const file = c.match(/classname="([^"]+)"/)?.[1]?.replace(/\./g, "/") ?? "";
		const failed = c.includes("<failure") || c.includes("<error");
		const skipped = c.includes("<skipped");
		const msg = c.match(/<failure[^>]*>([\s\S]*?)<\/failure>/)?.[1]?.slice(0, 500);
		results.push({
			name: name.split(" > ").pop() ?? name,
			file: file ? `${file}.test.ts` : "",
			status: failed ? "fail" : skipped ? "skip" : "pass",
			durationMs: Number(c.match(/time="([\d.]+)"/)?.[1] ?? 0) * 1000,
			message: msg?.trim(),
		});
	}
	return results.length ? results : null;
}

/** 控制台输出兜底解析(bun test 默认格式) */
function parseConsole(text: string, testFiles: string[]): TestOutcome[] {
	const results: TestOutcome[] = [];
	// (pass) name [1.2ms] / (fail) name
	const re = /\((pass|fail|skip)\)\s+(.+?)\s*(?:\[[\d.]+ms\])?$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const status = m[1] as "pass" | "fail" | "skip";
		const name = m[2].trim();
		if (name.startsWith("✓") || name.length === 0) continue;
		results.push({ name, file: guessFile(name, text, testFiles), status, durationMs: 0 });
	}
	return results;
}

function guessFile(name: string, text: string, testFiles: string[]): string {
	const idx = text.indexOf(name);
	const around = text.slice(Math.max(0, idx - 500), idx);
	const fileMatch = around.match(/([\w./\\-]+\.test\.[tj]sx?)/g);
	return fileMatch?.[fileMatch.length - 1] ?? testFiles[0] ?? "";
}
