/**
 * FileService — 编辑器后端(M2):列目录 / 读 / 写
 *
 * - 一切操作以 workspaceId 寻址(经 WorkspaceManager.locate 得到绝对路径)
 * - 写操作走信任门(W1);路径限制在仓库内(拒绝 .. 逃逸)
 * - 读取带大小上限(100MB 防御),编辑器大文件性能由前端 CM6 负责
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { WorkspaceManager } from "./workspace-manager";

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".hutch",
	"runtime",
]);

const MAX_READ = 100 * 1024 * 1024;

export class FileService {
	constructor(private workspaces: WorkspaceManager) {}

	private resolveSafe(workspaceId: string, relPath: string): { ok: true; abs: string } | { ok: false; error: string } {
		const { cwd } = this.workspaces.locate(workspaceId);
		if (!cwd) return { ok: false, error: "工作区不存在" };
		const abs = resolve(join(cwd, relPath));
		const normRoot = resolve(cwd) + sep;
		if (!(abs + sep).startsWith(normRoot)) {
			return { ok: false, error: "路径越界(拒绝仓库外访问)" };
		}
		return { ok: true, abs };
	}

	list(workspaceId: string, relPath: string) {
		const r = this.resolveSafe(workspaceId, relPath);
		if (!r.ok) return { ok: false as const, error: r.error };
		try {
			const dirents = readdirSync(r.abs, { withFileTypes: true });
			const entries = dirents
				.filter((d) => !IGNORED_DIRS.has(d.name))
				.map((d) => ({ name: d.name, kind: d.isDirectory() ? ("dir" as const) : ("file" as const) }))
				.sort((a, b) =>
					a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
				);
			return { ok: true as const, entries };
		} catch (err: any) {
			return { ok: false as const, error: String(err?.message ?? err) };
		}
	}

	read(workspaceId: string, relPath: string) {
		const r = this.resolveSafe(workspaceId, relPath);
		if (!r.ok) return { ok: false as const, error: r.error };
		try {
			const st = statSync(r.abs);
			if (!st.isFile()) return { ok: false as const, error: "不是文件" };
			if (st.size > MAX_READ) return { ok: false as const, error: `文件过大(${Math.round(st.size / 1048576)}MB > 100MB 上限)` };
			const content = readFileSync(r.abs, "utf8");
			return { ok: true as const, content, size: st.size };
		} catch (err: any) {
			return { ok: false as const, error: String(err?.message ?? err) };
		}
	}

	write(workspaceId: string, relPath: string, content: string) {
		// W1:写操作需要项目信任
		const { projectId } = this.workspaces.locate(workspaceId);
		if (projectId) {
			const trust = this.workspaces.requireTrusted(projectId);
			if (!trust.ok) return { ok: false as const, error: trust.error };
		}
		const r = this.resolveSafe(workspaceId, relPath);
		if (!r.ok) return { ok: false as const, error: r.error };
		try {
			writeFileSync(r.abs, content, "utf8");
			return { ok: true as const };
		} catch (err: any) {
			return { ok: false as const, error: String(err?.message ?? err) };
		}
	}
}
