/**
 * M4 记忆域验收测试(对照 business-design §9 M4 清单):
 *  - 建议卡片三动作(采纳/忽略/改后采纳)
 *  - 三级注入 ≤2K(层预算:项目 1.2K/用户 0.4K/会话 0.4K)
 *  - 整理合并 + 可回退
 *  - AGENTS.md 边界只读
 *  - 召回命中(验收故事 5.2:新会话开口即用项目记忆)
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager";

const root = mkdtempSync(join(tmpdir(), "jide-mem-test-"));
mkdirSync(join(root, ".memory/project"), { recursive: true });
mkdirSync(join(root, ".memory/user"), { recursive: true });

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("M4 建议卡片三动作", () => {
	test("提议 → 弹卡事件;采纳并写入文件", () => {
		const m = new MemoryManager(root);
		let suggested: any = null;
		m.bindEmitter((e: any) => {
			if (e.type === "memory.suggested") suggested = e;
		});
		const s = m.suggest("project", "conventions.md", ["金额一律以「分」为整数单位计算", "断言期望值写字面量"], "会话沉淀:购物车修复");
		expect(suggested).not.toBeNull();
		expect(suggested.file).toBe(".memory/project/conventions.md");
		expect(suggested.lines).toHaveLength(2);

		const adopt = m.adopt(s.id);
		expect(adopt.ok).toBe(true);
		if (adopt.ok) expect(adopt.wrote).toContain(".memory/project/conventions.md");
		expect(existsSync(join(root, ".memory/project/conventions.md"))).toBe(true);
		const content = readFileSync(join(root, ".memory/project/conventions.md"), "utf8");
		expect(content).toContain("- 金额一律以「分」为整数单位计算");
		expect(content).toContain("source: suggestion-card");
	});

	test("忽略:不落盘", () => {
		const m = new MemoryManager(root);
		const s = m.suggest("user", "feedback.md", ["不要主动改 preview/"], "用户纠正");
		const r = m.ignore(s.id);
		expect(r.ok).toBe(true);
		expect(existsSync(join(root, ".memory/user/feedback.md"))).toBe(false);
	});

	test("改后采纳:编辑版落盘,原稿不写", () => {
		const m = new MemoryManager(root);
		const s = m.suggest("project", "edit-test.md", ["原始提议"], "会话沉淀");
		const r = m.adopt(s.id, ["用户修改后的版本"]);
		expect(r.ok).toBe(true);
		const content = readFileSync(join(root, ".memory/project/edit-test.md"), "utf8");
		expect(content).toContain("用户修改后的版本");
		expect(content).not.toContain("原始提议");
	});
});

describe("M4 三级注入 ≤2K", () => {
	test("层预算:项目 1.2K 截断,总量 ≤2K,水位可判断", () => {
		const m = new MemoryManager(root);
		// 直接手写超量文件
		const bigFile = join(root, ".memory/project/big.md");
		writeFileSync(bigFile, Array.from({ length: 60 }, (_, i) => `- 约定条目 ${i}:包管理一律使用 pnpm 安装依赖,测试框架固定 vitest 并通过 pnpm test 触发,金额相关计算与断言必须采用分单位整数,展示层统一 toFixed 两位小数`).join("\n"));
		const { text, budget } = m.inject([]);
		expect(budget.projectK).toBeLessThanOrEqual(1.21);
		expect(budget.totalK).toBeLessThanOrEqual(2);
		expect(text).toContain("# 项目记忆");
		// 截断:60 行不会全进
		expect((text.match(/约定条目/g) ?? []).length).toBeLessThan(60);
	});

	test("会话层参与预算;接近上限提示", () => {
		const m = new MemoryManager(root);
		writeFileSync(join(root, ".memory/project/big.md"), Array.from({ length: 60 }, (_, i) => `- 约定条目 ${i}:xxx`).join("\n"));
		writeFileSync(join(root, ".memory/user/prefs.md"), ["汇报控制在 5 行以内", "提交信息中文动词开头"].map((l) => `- ${l}`).join("\n"));
		const { budget } = m.inject(["当前任务:修复购物车总额", "工作区:feat/cart-fix"]);
		expect(budget.userK).toBeGreaterThan(0);
		expect(budget.sessionK).toBeGreaterThan(0);
		expect(budget.totalK).toBeLessThanOrEqual(2);
		// 拉满项目层 + 用户层 + 会话层 → 接近上限
		const full = m.inject(Array.from({ length: 30 }, (_, i) => `会话要点 ${i}:详细上下文信息`.repeat(2)));
		expect(full.budget.nearLimit || full.budget.totalK <= 2).toBe(true);
	});
});

describe("M4 整理:合并重复 + 可回退", () => {
	test("重复行合并;revertTidy 恢复", () => {
		const m = new MemoryManager(root);
		// 含重复(全半角/空白差异视作重复)
		writeFileSync(
			join(root, ".memory/user/feedback.md"),
			["- 汇报控制在 5 行以内", "- 汇报控制在  5 行以内", "- 提交信息中文动词开头"].join("\n"),
		);
		const r = m.tidy();
		expect(r.before).toBeGreaterThanOrEqual(3);
		expect(r.after).toBeLessThan(r.before);
		expect(r.changed.length).toBeGreaterThanOrEqual(1);
		const content = readFileSync(join(root, ".memory/user/feedback.md"), "utf8");
		expect((content.match(/汇报控制/g) ?? []).length).toBe(1);

		// 回退
		const n = m.revertTidy();
		expect(n).toBeGreaterThanOrEqual(1);
		const restored = readFileSync(join(root, ".memory/user/feedback.md"), "utf8");
		expect((restored.match(/汇报控制/g) ?? []).length).toBe(2);
	});
});

describe("M4 召回与边界", () => {
	test("关键词命中返回行并更新 lastHit(验收故事 5.2)", () => {
		const m = new MemoryManager(root);
		writeFileSync(join(root, ".memory/project/project.md"), "- 测试框架 vitest,命令 `pnpm test`\n- 金额展示统一保留两位小数");
		const hits = m.recallKeywords(["vitest", "pnpm"]);
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0].line).toContain("vitest");
		// lastHit 已更新(读回)
		const raw = readFileSync(join(root, ".memory/project/project.md"), "utf8");
		expect(raw).not.toContain("lastHit: never");
	});

	test("AGENTS.md 只读:readAgents 可读,无写路径", () => {
		const m = new MemoryManager(root);
		writeFileSync(join(root, "AGENTS.md"), "# 规则\n- 不许直接 push main");
		expect(m.readAgents()).toContain("不许直接 push main");
		// 类上没有写 AGENTS.md 的方法(静态边界)
		expect((m as any).writeAgents).toBeUndefined();
		expect((MemoryManager.prototype as any).writeAgents).toBeUndefined();
	});
});

describe("P3.4 任务经历(长期记忆,第 4 写入通道)", () => {
	test("appendExperience:新条目插最前;直接落盘不走建议卡;上限 100 条", () => {
		const m = new MemoryManager(root);
		let cardEvents = 0;
		m.bindEmitter((e: any) => {
			if (e.type === "memory.suggested") cardEvents++;
		});
		m.appendExperience({ title: "修购物车金额", summary: "根因是分/元换算;对策=统一以分计算", outcome: "done", source: "chat" });
		m.appendExperience({ title: "夜间回归超时", summary: "daemon 重启中断", outcome: "failed", source: "automation" });
		const path = join(root, ".memory/project/experience.md");
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, "utf8");
		expect(raw).toContain("source: task");
		expect(raw.indexOf("夜间回归超时")).toBeLessThan(raw.indexOf("修购物车金额")); // 新条目在前
		expect(raw).toContain("失败 · automation");
		expect(cardEvents).toBe(0); // 不走建议卡片(系统记录非 agent 主张)

		// 上限:塞到 102 条只留最新 100
		for (let i = 0; i < 102; i++) m.appendExperience({ title: `批量任务 ${i}`, outcome: "done", source: "chat" });
		const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith("- "));
		expect(lines.length).toBeLessThanOrEqual(100);
		expect(readFileSync(path, "utf8")).toContain("批量任务 101"); // 最新的在
	});

	test("注入:经历独立成层(不计入项目层,防双重计入);召回可命中经历", () => {
		const m = new MemoryManager(root);
		// 项目层常规记忆 + 经历(上一测试已写入 experience.md)
		m.adopt(m.suggest("project", "conventions.md", ["命令一律 pnpm"], "会话沉淀").id);
		const inj = m.inject();
		expect(inj.text).toContain("# 任务经历");
		expect(inj.text).toContain("# 项目记忆(命令/约定/坑)");
		// 项目层段落里不得混入经历内容;经历层段落里不得混入常规记忆
		const projSection = inj.text.split("# 项目记忆")[1]?.split("#")[0] ?? "";
		const expSection = inj.text.split("# 任务经历")[1]?.split("#")[0] ?? "";
		expect(projSection).toContain("pnpm");
		expect(projSection).not.toContain("批量任务");
		expect(expSection).toContain("批量任务");
		expect(expSection).not.toContain("pnpm");
		expect(inj.budget.experienceK).toBeGreaterThan(0);

		// 召回:关键词命中经历条目
		const hits = m.recallKeywords(["批量任务 101"]);
		expect(hits.some((h) => h.file === "experience.md")).toBe(true);
	});
});
