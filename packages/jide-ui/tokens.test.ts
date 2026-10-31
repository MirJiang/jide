// usage 测试:锁定生成物与源同步(改 tokens.src.json 必须重跑 generate 脚本)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, "tokens.src.json"), "utf8"));
const css = readFileSync(join(here, "dist", "tokens.css"), "utf8");

describe("jide-ui 设计令牌(生成物锁定)", () => {
	test("每个源令牌都有对应 CSS 变量", () => {
		let n = 0;
		for (const [group, entries] of Object.entries(src)) {
			for (const name of Object.keys(entries)) {
				const varName = `--jide-${group}-${name.toLowerCase()}`;
				expect(css).toContain(varName);
				n++;
			}
		}
		expect(n).toBeGreaterThanOrEqual(20);
	});
	test("生成物是最新(若失败:重跑 bun packages/jide-ui/scripts/generate-tokens.mjs)", () => {
		// 源里最后一个令牌的值必须出现在 css 里(抽查尾项防陈旧)
		const groups = Object.entries(src);
		const [lastGroup, lastEntries] = groups[groups.length - 1];
		const entries = Object.entries(lastEntries as Record<string, string>);
		const [lastName, lastValue] = entries[entries.length - 1];
		expect(css).toContain(lastValue);
		void lastName;
	});
});
