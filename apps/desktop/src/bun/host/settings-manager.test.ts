/**
 * SettingsManager 测试:默认值兜底 / 部分更新合并 / 持久化往返 / 损坏文件回落
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager, DEFAULT_SETTINGS } from "./settings-manager";

const root = mkdtempSync(join(tmpdir(), "jide-settings-test-"));

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("设置管理", () => {
	beforeAll(() => {
		expect(DEFAULT_SETTINGS.terminalShell).toBe("cmd");
	});

	test("无 settings.json:全默认值", () => {
		const sm = new SettingsManager(join(root, "a"));
		const s = sm.get();
		expect(s.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);
		expect(s.devserver.probe).toBe("auto");
	});

	test("部分更新:浅合并 + devserver 子对象合并,持久化往返", () => {
		const dir = join(root, "b");
		const sm = new SettingsManager(dir);
		const merged = sm.set({ editorFontSize: 14, devserver: { port: 5199, probe: "log" } });
		expect(merged.editorFontSize).toBe(14);
		// devserver 未给字段保留默认
		expect(merged.devserver.probe).toBe("log");
		expect(merged.devserver.port).toBe(5199);
		expect(merged.devserver.readyPattern).toBe("");

		// 重启(新实例)读回
		const sm2 = new SettingsManager(dir);
		const reloaded = sm2.get();
		expect(reloaded.editorFontSize).toBe(14);
		expect(reloaded.devserver.port).toBe(5199);
	});

	test("损坏 settings.json:静默回落默认值;历史遗留未知键被忽略", () => {
		const dir = join(root, "c");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), '{not json');
		const sm = new SettingsManager(dir);
		expect(sm.get().editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);

		const dir2 = join(root, "d");
		mkdirSync(dir2, { recursive: true });
		writeFileSync(join(dir2, "settings.json"), JSON.stringify({ demoMode: true, editorFontSize: 16 }));
		const sm2 = new SettingsManager(dir2);
		expect((sm2.get() as any).demoMode).toBeUndefined();
		expect(sm2.get().editorFontSize).toBe(16);
	});

	test("模型配置:favoriteModels 去重保序;非法 key 丢弃;defaultModel 校验;持久化往返", () => {
		const dir = join(root, "e");
		const sm = new SettingsManager(dir);
		const merged = sm.set({
			favoriteModels: ["anthropic/claude-x", "bad-key-no-slash", "anthropic/claude-x", "/leading", "zhipu/glm-5"],
			defaultModel: "zhipu/glm-5",
		});
		expect(merged.favoriteModels).toEqual(["anthropic/claude-x", "zhipu/glm-5"]);
		expect(merged.defaultModel).toBe("zhipu/glm-5");

		// 非法 defaultModel → 清空
		expect(sm.set({ defaultModel: "no-slash" }).defaultModel).toBe("");

		// 重启读回
		const sm2 = new SettingsManager(dir);
		expect(sm2.get().favoriteModels).toEqual(["anthropic/claude-x", "zhipu/glm-5"]);
	});

	test("模型配置:get() 返回副本(改返回值不影响内部状态)", () => {
		const dir = join(root, "f");
		const sm = new SettingsManager(dir);
		sm.set({ favoriteModels: ["p/m1"] });
		const s = sm.get();
		s.favoriteModels.push("p/m2");
		expect(sm.get().favoriteModels).toEqual(["p/m1"]);
	});
});
