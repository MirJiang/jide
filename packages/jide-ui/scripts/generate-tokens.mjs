// 设计令牌代码生成(tech-stack §4:ThinkRail 模式)
// 源:tokens.src.json(唯一事实)→ 产出 tokens.css(CSS 变量)
// usage 测试锁定:tokens.test.ts 断言生成物与源一致(改源必须重跑 generate)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, "..", "tokens.src.json"), "utf8"));

const lines = ["/* 自动生成:勿手改。源 tokens.src.json,脚本 scripts/generate-tokens.mjs */", ":root {"];
let count = 0;
for (const [group, entries] of Object.entries(src)) {
	for (const [name, value] of Object.entries(entries)) {
		lines.push(`  --jide-${group}-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}: ${value};`);
		count++;
	}
}
lines.push("}");
const css = lines.join("\n") + "\n";
mkdirSync(join(here, "..", "dist"), { recursive: true });
writeFileSync(join(here, "..", "dist", "tokens.css"), css);
writeFileSync(join(here, "..", "dist", "tokens.json"), JSON.stringify(src, null, "\t"));
console.log(`generated ${count} tokens → dist/tokens.css`);
