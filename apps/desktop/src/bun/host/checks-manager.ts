/**
 * ChecksManager — 检查项 4E(business-design §4E)
 *
 *  - 两类:项目资产(.jide/checks/*.json,跨会话复用、diff 命中自动带上)/ 临时(内存)
 *  - 断言三类:http(经 HttpProbe)/ browser(经 BrowserAutomation)/ manual(占位)
 *  - 执行结果带 evidence(HTTP 实际值);全部结果经 checks.updated 事件推送
 *  - appliesTo:diff 命中这些路径模式时,该检查项自动加入复验集
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CheckAssertion } from "@jide/contracts";
import type { EmitFn } from "./agent-host";
import { HttpProbe } from "./test-runner";
import type { BrowserAutomation } from "./browser-automation";

export interface CheckItem {
	id: string;
	title: string;
	kind: "asset" | "temp";
	assertion: CheckAssertion;
	appliesTo?: string[];
	lastResult?: { passed: boolean; at: string; evidence?: string };
}

export class ChecksManager {
	private temp = new Map<string, Map<string, CheckItem>>();
	private nextTemp = 1;
	private emit: EmitFn = () => {};

	constructor(
		private browsers: BrowserAutomation,
		private probe = HttpProbe.run,
	) {}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private assetDir(workspaceId: string): string | null {
		// 由调用方注入 workspace cwd;简化:workspaceId 里查不到路径时返回 null
		return (this as any).__cwdFor?.(workspaceId) ?? null;
	}

	/** 注入 workspaceId → cwd 解析(避免与 WorkspaceManager 循环依赖) */
	setCwdResolver(fn: (workspaceId: string) => string | null) {
		(this as any).__cwdFor = fn;
	}

	private assetsDirFor(cwd: string) {
		return join(cwd, ".jide", "checks");
	}

	list(workspaceId: string): CheckItem[] {
		const cwd = this.assetDir(workspaceId);
		const assets: CheckItem[] = [];
		if (cwd) {
			const dir = this.assetsDirFor(cwd);
			if (existsSync(dir)) {
				for (const f of readdirSync(dir)) {
					if (!f.endsWith(".json")) continue;
					try {
						assets.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
					} catch {
						/* skip */
					}
				}
			}
		}
		return [...assets, ...(this.temp.get(workspaceId)?.values() ?? [])];
	}

	create(workspaceId: string, title: string, kind: "asset" | "temp", assertion: CheckAssertion, appliesTo?: string[]) {
		const id = kind === "asset" ? `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` : `tmp-${this.nextTemp++}`;
		const item: CheckItem = { id, title, kind, assertion, appliesTo };
		if (kind === "asset") {
			const cwd = this.assetDir(workspaceId);
			if (!cwd) return { ok: false as const, error: "工作区不存在" };
			const dir = this.assetsDirFor(cwd);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${id}.json`), JSON.stringify(item, null, "\t"));
		} else {
			if (!this.temp.has(workspaceId)) this.temp.set(workspaceId, new Map());
			this.temp.get(workspaceId)!.set(id, item);
		}
		return { ok: true as const, id };
	}

	delete(workspaceId: string, id: string) {
		const cwd = this.assetDir(workspaceId);
		if (cwd) {
			const p = join(this.assetsDirFor(cwd), `${id}.json`);
			if (existsSync(p)) rmSync(p);
		}
		this.temp.get(workspaceId)?.delete(id);
		return { ok: true as const };
	}

	/** diff 命中自动带上的检查项(资产 + appliesTo 模式匹配) */
	selectForDiff(workspaceId: string, changedFiles: string[]): CheckItem[] {
		return this.list(workspaceId).filter((c) => {
			if (!c.appliesTo?.length) return false;
			return c.appliesTo.some((pattern) =>
				changedFiles.some((f) => {
					const rx = new RegExp("^" + pattern.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
					return rx.test(f);
				}),
			);
		});
	}

	/** 执行(ids 为空 = 全部);http 走探针,browser 走自动化引擎,manual 恒 pending */
	async run(workspaceId: string, ids?: string[]) {
		try {
			return await this.runUnsafe(workspaceId, ids);
		} catch (err: any) {
			return { ok: false as const, error: String(err?.message ?? err) };
		}
	}

	private async runUnsafe(workspaceId: string, ids?: string[]) {
		const all = this.list(workspaceId);
		const targets = ids?.length ? all.filter((c) => ids.includes(c.id)) : all;
		const results: Array<{ id: string; title: string; passed: boolean; detail?: string; evidence?: string }> = [];
		for (const c of targets) {
			let passed = false;
			let detail = "";
			let evidence = "";
			if (c.assertion.type === "http" && c.assertion.url) {
				const r = await this.probe(c.assertion.url, {
					expectStatus: c.assertion.expectStatus,
					contains: c.assertion.contains,
				});
				if (r.ok) {
					passed = r.passed;
					detail = r.passed ? "" : (r.detail ?? "");
					evidence = r.actual;
				} else {
					detail = r.error;
				}
			} else if (c.assertion.type === "browser" && c.assertion.url) {
				const nav = await this.browsers.navigate(workspaceId, c.assertion.url);
				if (!nav.ok) {
					detail = nav.error;
				} else if (c.assertion.clickSelector) {
					const click = await this.browsers.click(workspaceId, c.assertion.clickSelector);
					if (!click.ok) detail = click.error;
				}
				if (!detail && c.assertion.expectContains) {
					const text = await this.browsers.textContent(workspaceId);
					if (text.ok) {
						passed = text.text.includes(c.assertion.expectContains);
						if (!passed) detail = `页面未包含 "${c.assertion.expectContains}"`;
					} else detail = text.error;
				} else if (!detail) {
					passed = true;
				}
			} else {
				// manual:按上次结果或视为待人工
				passed = c.lastResult?.passed ?? false;
				detail = c.assertion.note ?? "人工检查项";
			}
			const rec = { passed, at: new Date().toISOString(), evidence: evidence || undefined };
			this.persistResult(workspaceId, c, rec);
			results.push({ id: c.id, title: c.title, passed, detail: detail || undefined, evidence: evidence || undefined });
		}
		this.emit({
			type: "checks.updated",
			workspaceId,
			results: results.map((r) => ({ id: r.id, title: r.title, passed: r.passed, detail: r.detail })),
		});
		return { ok: true as const, results };
	}

	private persistResult(workspaceId: string, item: CheckItem, rec: { passed: boolean; at: string; evidence?: string }) {
		item.lastResult = rec;
		if (item.kind === "asset") {
			const cwd = this.assetDir(workspaceId);
			if (cwd) {
				writeFileSync(join(this.assetsDirFor(cwd), `${item.id}.json`), JSON.stringify(item, null, "\t"));
			}
		}
	}
}
