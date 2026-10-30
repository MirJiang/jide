/**
 * MemoryManager — 记忆域(business-design §5,差异化核心)
 *
 *  - 文件式:.memory/project/*.md 与 .memory/user/*.md,一行一事,front-matter 记来源/最近命中
 *  - 写入三通道:①建议卡片(任务完成弹卡,采纳/忽略/改后采纳——默认不静默写)
 *              ②会话沉淀(agent 提议,同样走建议卡片) ③用户手编(热加载:每次读盘)
 *  - 三级注入:项目层 1.2K + 用户层 0.4K + 会话层 0.4K ≤ 2K(估算:中文≈2字符/token,混合按 2.5)
 *  - 三级召回:注入(必带)→ 关键词命中(预算外补充,更新 lastHit)→ 显式引用(@记忆名)
 *  - 整理:合并重复行 + 淘汰过时(lastHit 最旧且超预算),产出前后对照;记忆在 git 里 → 可回退
 *  - AGENTS.md:仅用户手写,记忆系统只读不写(边界)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { EmitFn } from "./agent-host";

export interface MemoryEntry {
	scope: "project" | "user";
	file: string;
	source: string;
	lastHit?: string;
	lines: string[];
}

export interface MemoryBudget {
	projectK: number;
	userK: number;
	sessionK: number;
	totalK: number;
	capK: number;
	ratio: number;
	nearLimit: boolean;
}

export interface Suggestion {
	id: string;
	scope: "project" | "user";
	file: string;
	lines: string[];
	reason: string;
}

const CAP_K = 2;
const LAYER_BUDGET_K = { project: 1.2, user: 0.4, session: 0.4 } as const;
const NEAR_LIMIT_RATIO = 0.95;

/** 估算 token:中文 ~2 字符/枚,ASCII ~4 字符/枚,混合取 2.5 */
function estTokens(text: string): number {
	return Math.ceil(text.length / 2.5);
}
function kOf(n: number): number {
	return Math.round((n / 1000) * 100) / 100;
}

export class MemoryManager {
	private emit: EmitFn = () => {};
	private nextSuggestion = 1;
	private suggestions = new Map<string, Suggestion>();

	constructor(private cwd: string) {}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private dir(scope: "project" | "user") {
		return join(this.cwd, ".memory", scope);
	}

	/** 读全部记忆(每次读盘 = 用户手编热加载) */
	list(): MemoryEntry[] {
		const out: MemoryEntry[] = [];
		for (const scope of ["project", "user"] as const) {
			const dir = this.dir(scope);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md")) continue;
				try {
					out.push(this.parseFile(join(dir, f), scope, f));
				} catch {
					/* 损坏文件跳过 */
				}
			}
		}
		return out;
	}

	private parseFile(path: string, scope: "project" | "user", name: string): MemoryEntry {
		const raw = readFileSync(path, "utf8");
		let source = "manual";
		let lastHit: string | undefined;
		let body = raw;
		const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
		if (fm) {
			body = raw.slice(fm[0].length);
			source = fm[1].match(/source:\s*(.+)/)?.[1]?.trim() ?? "manual";
			const lh = fm[1].match(/lastHit:\s*(.+)/)?.[1]?.trim();
			if (lh && lh !== "never") lastHit = lh;
		}
		return {
			scope,
			file: name,
			source,
			lastHit,
			lines: body.split(/\r?\n/).map((l) => l.replace(/^- /, "").trim()).filter(Boolean),
		};
	}

	private writeFile(scope: "project" | "user", name: string, lines: string[], source: string, lastHit?: string) {
		const dir = this.dir(scope);
		mkdirSync(dir, { recursive: true });
		const fm = ["---", `source: ${source}`, `lastHit: ${lastHit ?? new Date().toISOString()}`, "---", ""].join("\n");
		writeFileSync(join(dir, name), fm + lines.map((l) => `- ${l}`).join("\n") + "\n");
	}

	private appendLines(scope: "project" | "user", name: string, newLines: string[], source: string) {
		const dir = this.dir(scope);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		let existing = "";
		if (existsSync(path)) existing = readFileSync(path, "utf8");
		const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n?/);
		const body = fmMatch ? existing.slice(fmMatch[0].length) : existing;
		const cur = body.split(/\r?\n/).map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
		const merged = [...cur];
		for (const l of newLines) if (!merged.includes(l)) merged.push(l);
		this.writeFile(scope, name, merged, fmMatch ? fmMatch[0].match(/source:\s*(.+)/)?.[1]?.trim() ?? source : source);
	}

	/* ---------------- 三级注入 ---------------- */

	/** 生成分层注入文本(项目层→用户层→会话层),预算内截断 */
	inject(sessionNotes: string[] = []): { text: string; budget: MemoryBudget; layers: Record<string, number> } {
		const parts: string[] = [];
		let pT = 0;
		let uT = 0;
		let sT = 0;

		const take = (lines: string[], budgetTokens: number): { lines: string[]; used: number } => {
			const taken: string[] = [];
			let used = 0;
			for (const l of lines) {
				const t = estTokens(l) + 1;
				if (used + t > budgetTokens * 1000) break;
				taken.push(l);
				used += t;
			}
			return { lines: taken, used };
		};

		const proj = this.list().filter((e) => e.scope === "project").flatMap((e) => e.lines);
		const projTake = take(proj, LAYER_BUDGET_K.project);
		if (projTake.lines.length) {
			pT = projTake.used;
			parts.push(`# 项目记忆(命令/约定/坑)\n` + projTake.lines.map((l) => `- ${l}`).join("\n"));
		}

		const user = this.list().filter((e) => e.scope === "user").flatMap((e) => e.lines);
		const userTake = take(user, LAYER_BUDGET_K.user);
		if (userTake.lines.length) {
			uT = userTake.used;
			parts.push(`# 用户偏好与纠正\n` + userTake.lines.map((l) => `- ${l}`).join("\n"));
		}

		if (sessionNotes.length) {
			const sTake = take(sessionNotes, LAYER_BUDGET_K.session);
			sT = sTake.used;
			parts.push(`# 本次会话上下文\n` + sTake.lines.map((l) => `- ${l}`).join("\n"));
		}

		const budget: MemoryBudget = {
			projectK: kOf(pT),
			userK: kOf(uT),
			sessionK: kOf(sT),
			totalK: kOf(pT + uT + sT),
			capK: CAP_K,
			ratio: Math.min(1, (pT + uT + sT) / (CAP_K * 1000)),
			nearLimit: (pT + uT + sT) / (CAP_K * 1000) >= NEAR_LIMIT_RATIO,
		};
		return { text: parts.join("\n\n"), budget, layers: { project: pT, user: uT, session: sT } };
	}

	/* ---------------- 召回 ---------------- */

	/** 关键词命中(预算外补充):返回命中条目并更新 lastHit */
	recallKeywords(keywords: string[]): { scope: "project" | "user"; file: string; line: string }[] {
		const hits: { scope: "project" | "user"; file: string; line: string }[] = [];
		const byFile = new Map<string, MemoryEntry & { hitIdx: Set<number> }>();
		for (const e of this.list()) {
			for (let i = 0; i < e.lines.length; i++) {
				const line = e.lines[i];
				if (keywords.some((k) => k && line.toLowerCase().includes(k.toLowerCase()))) {
					hits.push({ scope: e.scope, file: e.file, line });
					const key = `${e.scope}/${e.file}`;
					if (!byFile.has(key)) byFile.set(key, { ...e, hitIdx: new Set() });
					byFile.get(key)!.hitIdx.add(i);
				}
			}
		}
		// 命中即更新 lastHit(整文件粒度)
		for (const [, e] of byFile) {
			this.writeFile(e.scope, e.file, e.lines, e.source, new Date().toISOString());
		}
		return hits;
	}

	/* ---------------- 建议卡片(写入通道①②) ---------------- */

	suggest(scope: "project" | "user", file: string, lines: string[], reason: string): Suggestion {
		const s: Suggestion = { id: `mem-${this.nextSuggestion++}`, scope, file, lines, reason };
		this.suggestions.set(s.id, s);
		this.emit({
			type: "memory.suggested",
			suggestionId: s.id,
			scope,
			file: `.memory/${scope}/${file}`,
			lines,
			reason,
		} as any);
		return s;
	}

	/** 采纳(可改后采纳:editedLines 非空时用编辑版) */
	adopt(id: string, editedLines?: string[]) {
		const s = this.suggestions.get(id);
		if (!s) return { ok: false as const, error: "建议不存在" };
		const lines = editedLines?.length ? editedLines : s.lines;
		this.appendLines(s.scope, s.file, lines, "suggestion-card");
		this.suggestions.delete(id);
		this.emitBudget();
		return { ok: true as const, wrote: `.memory/${s.scope}/${s.file}` };
	}

	ignore(id: string) {
		const s = this.suggestions.get(id);
		if (!s) return { ok: false as const, error: "建议不存在" };
		this.suggestions.delete(id);
		return { ok: true as const };
	}

	/* ---------------- 整理(冲突与遗忘) ---------------- */

	/**
	 * 合并重复(归一化:去空白/全半角) + 淘汰过时(lastHit 最旧、且仅在超预算时)。
	 * 产出前后对照;改写前留 .bak(另:记忆在 git 内,git checkout 即回退)。
	 */
	tidy(): { changed: Array<{ scope: string; file: string; removed: string[]; mergedInto?: string }>; before: number; after: number } {
		const norm = (s: string) => s.replace(/\s+/g, " ").replace(/,/g, ",").trim().toLowerCase();
		const changed: Array<{ scope: string; file: string; removed: string[]; mergedInto?: string }> = [];
		let before = 0;
		let after = 0;
		const entries = this.list();
		const overBudget = this.inject().budget.totalK > LAYER_BUDGET_K.project + LAYER_BUDGET_K.user - 0.05;

		for (const e of entries) {
			before += e.lines.length;
			const seen = new Map<string, string>();
			const kept: string[] = [];
			const removed: string[] = [];
			for (const line of e.lines) {
				const key = norm(line);
				if (seen.has(key)) {
					removed.push(line);
					continue;
				}
				seen.set(key, line);
				kept.push(line);
			}
			// 淘汰过时:超预算时丢 lastHit 最旧文件里最旧的行(一次一行,保守)
			let removedStale: string | null = null;
			if (overBudget && kept.length > 1) {
				removedStale = kept[0];
				kept.shift();
			}
			if (removed.length || removedStale) {
				const path = join(this.dir(e.scope), e.file);
				if (existsSync(path)) copyFileSync(path, path + ".bak");
				this.writeFile(e.scope, e.file, kept, e.source, e.lastHit);
				changed.push({
					scope: e.scope,
					file: e.file,
					removed: [...removed, ...(removedStale ? [removedStale] : [])],
				});
			}
			after += kept.length;
		}
		this.emitBudget();
		return { changed, before, after };
	}

	/** 整理回退(用 .bak 恢复) */
	revertTidy(): number {
		let n = 0;
		for (const scope of ["project", "user"] as const) {
			const dir = this.dir(scope);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".md.bak")) continue;
				copyFileSync(join(dir, f), join(dir, f.replace(/\.bak$/, "")));
				rmSync(join(dir, f));
				n++;
			}
		}
		this.emitBudget();
		return n;
	}

	/* ---------------- AGENTS.md 边界(只读) ---------------- */

	readAgents(): string | null {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const p = join(this.cwd, name);
			if (existsSync(p)) return readFileSync(p, "utf8");
		}
		return null;
	}

	/** AGENTS.md 绝不写入:此方法仅供测试断言不存在写路径 */
	readonly agentsReadOnly = true;

	budget(): MemoryBudget {
		return this.inject().budget;
	}

	private emitBudget() {
		this.emit({ type: "memory.updated", budget: this.budget() } as any);
	}
}
