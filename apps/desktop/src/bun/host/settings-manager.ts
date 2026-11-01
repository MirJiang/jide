/**
 * SettingsManager — 全局设置(~/.jide/settings.json)
 *
 * 持久化模式与 workspace-manager 的 projects.json 一致:启动读、变更即写、
 * 损坏文件静默回落默认值。UI 侧通过 settings.get / settings.set 访问。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseModelKey, type JideSettings } from "@jide/contracts";

export const DEFAULT_SETTINGS: JideSettings = {
	theme: "system",
	editorFontSize: 12.5,
	terminalFontSize: 12,
	terminalShell: "cmd",
	devserver: { port: 5175, probe: "auto", readyPattern: "", command: "" },
	favoriteModels: [],
	defaultModel: "",
};

/** 模型 key 数组规整:仅留合法 "<provider>/<modelId>",去重保序 */
function normModelKeys(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const x of v) {
		const k = String(x);
		if (parseModelKey(k) && !out.includes(k)) out.push(k);
	}
	return out;
}

function normModelKey(v: unknown): string {
	const k = String(v ?? "");
	return parseModelKey(k) ? k : "";
}

export class SettingsManager {
	private settings: JideSettings;
	private storePath: string;

	constructor(runtimeRoot: string) {
		mkdirSync(runtimeRoot, { recursive: true });
		this.storePath = join(runtimeRoot, "settings.json");
		this.settings = { ...DEFAULT_SETTINGS };
		if (existsSync(this.storePath)) {
			try {
				this.settings = this.merge(this.settings, JSON.parse(readFileSync(this.storePath, "utf8")));
			} catch {
				/* 损坏则保持默认 */
			}
		}
	}

	/** 显式挑键合并(devserver 子对象同理);磁盘/历史版本遗留的未知键一律丢弃 */
	private merge(base: JideSettings, patch: Partial<JideSettings>): JideSettings {
		const p = patch ?? {};
		return {
			theme: p.theme ?? base.theme,
			editorFontSize: p.editorFontSize ?? base.editorFontSize,
			terminalFontSize: p.terminalFontSize ?? base.terminalFontSize,
			terminalShell: p.terminalShell ?? base.terminalShell,
			devserver: {
				port: p.devserver?.port ?? base.devserver.port,
				probe: p.devserver?.probe ?? base.devserver.probe,
				readyPattern: p.devserver?.readyPattern ?? base.devserver.readyPattern,
				command: p.devserver?.command ?? base.devserver.command,
			},
			favoriteModels: normModelKeys(p.favoriteModels ?? base.favoriteModels),
			defaultModel: normModelKey(p.defaultModel ?? base.defaultModel),
		};
	}

	get(): JideSettings {
		return {
			...this.settings,
			devserver: { ...this.settings.devserver },
			favoriteModels: [...this.settings.favoriteModels],
		};
	}

	set(patch: Partial<JideSettings>): JideSettings {
		this.settings = this.merge(this.settings, patch);
		writeFileSync(this.storePath, JSON.stringify(this.settings, null, "\t"));
		return this.get();
	}
}
