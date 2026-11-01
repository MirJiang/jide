/**
 * DiffView — git diff 双全文视图(§6,business-design 原型冻结交互)
 *
 *  - 左 = HEAD 全文,右 = 工作区全文(@codemirror/merge,词级高亮)
 *  - 未更改区折叠(collapseUnchangedRegions)
 *  - 中缝 »/« 方向应用(revert 控制:右侧恢复到 HEAD 版本)
 *  - 变更间导航(‹ ›)+ 变更定位条(右侧 minimap 着色)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { MergeView } from "@codemirror/merge";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { useIDE } from "../store";

const theme = EditorView.theme(
	{
		"&": { height: "100%", backgroundColor: "var(--bg0)", fontSize: "12px" },
		".cm-gutters": { backgroundColor: "var(--bg0)", color: "var(--fg-faint)", border: "none" },
		".cm-changedLine": { background: "rgba(74,222,128,.13)" },
		".cm-deletedChunk": { background: "rgba(248,113,113,.12)" },
		".cm-insertedLine": { background: "rgba(74,222,128,.13)" },
		".cm-deletedChunk .cm-changedText": { background: "rgba(248,113,113,.30)", borderRadius: "2px" },
		".cm-insertedChunk .cm-changedText": { background: "rgba(74,222,128,.28)", borderRadius: "2px" },
		".cm-changedWidget": { color: "var(--green)" },
		".cm-foldPlaceholder": { background: "var(--bg2)", border: "1px dashed var(--line)", color: "var(--fg-faint)", borderRadius: "4px", padding: "0 6px" },
		".cm-mergeView": { height: "100%" },
		".cm-merge-revert button": { color: "var(--acc)", cursor: "pointer", border: "none", background: "none", font: "inherit" },
	},
	{ dark: true },
);

function langFor(path: string) {
	if (/\.(ts|tsx|js|jsx|mjs)$/.test(path)) return [javascript({ typescript: true })];
	if (/\.json$/.test(path)) return [json()];
	if (/\.md$/.test(path)) return [markdown()];
	return [];
}

export function DiffView({ path }: { path: string }) {
	const s = useIDE();
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<MergeView | null>(null);
	const [data, setData] = useState<{ head: string; work: string; headExists: boolean } | null>(null);
	const [chunkCount, setChunkCount] = useState(0);
	const [cur, setCur] = useState(0);

	// 取双全文
	useEffect(() => {
		void (async () => {
			if (!s.client || !s.activeWorkspaceId) return;
			const r = await s.client.request("git.fileDiff", { workspaceId: s.activeWorkspaceId, path });
			if (r.ok) setData({ head: r.headContent, work: r.workContent, headExists: r.headExists });
		})();
	}, [path, s.activeWorkspaceId]);

	// 统计变更块(粗略:diff 行数 → 块数;用于导航计数)
	const chunks = useMemo(() => {
		if (!data) return [] as number[];
		const headL = data.head.split("\n");
		const workL = data.work.split("\n");
		// 简易 LCS 跳过:以行集合差异估算块位置(导航滚动用)
		const positions: number[] = [];
		const max = Math.max(headL.length, workL.length);
		let inChunk = false;
		for (let i = 0; i < max; i++) {
			if (headL[i] !== workL[i] && !inChunk) {
				positions.push(i);
				inChunk = true;
			} else if (headL[i] === workL[i]) {
				inChunk = false;
			}
		}
		return positions;
	}, [data]);

	useEffect(() => {
		setChunkCount(chunks.length);
	}, [chunks]);

	// MergeView
	useEffect(() => {
		if (!hostRef.current || !data) return;
		const view = new MergeView({
			parent: hostRef.current,
			a: {
				doc: data.head,
				extensions: [basicSetup, theme, EditorState.readOnly.of(true), ...langFor(path)],
			},
			b: {
				doc: data.work,
				extensions: [
					basicSetup,
					theme,
					...langFor(path),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) {
							// 右侧被编辑(应用/手工)→ 写回 store 的 dirty 逻辑由保存按钮承担
						}
					}),
				],
			},
			foldUnchanged: { minSize: 4, margin: 3 } as any,
			collapseUnchangedRegions: { minSize: 4, margin: 3 } as any,
			revertControls: "a.b" as any, // 中缝方向应用:b→a(»)/a→b(«)
			gutter: true,
			highlightChanges: true,
			syntaxHighlightDeletions: true,
			syntaxHighlightInsertions: true,
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [data, path]);

	// 变更导航:滚动到第 n 个差异行
	const goTo = (i: number) => {
		const v = viewRef.current;
		if (!v) return;
		const line = chunks[((i % chunks.length) + chunks.length) % chunks.length] ?? 0;
		const editors = [v.a, v.b];
		for (const ed of editors) {
			const pos = ed.state.doc.line(Math.min(line + 1, ed.state.doc.lines)).from;
			ed.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
		}
		setCur((i + chunks.length) % chunks.length);
	};

	// 应用右侧编辑回文件(保存)
	const saveRight = async () => {
		const v = viewRef.current;
		if (!v || !s.client || !s.activeWorkspaceId) return;
		await s.client.request("fs.write", { workspaceId: s.activeWorkspaceId, relPath: path, content: v.b.state.doc.toString() });
		void s.refreshGit();
	};

	if (!data) {
		return <div className="p-4 text-xs" style={{ color: "var(--fg-faint)" }}>加载 diff…</div>;
	}

	const added = data.work.split("\n").length;
	const removed = data.head.split("\n").length;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 px-3.5 py-1.5 text-xs" style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)", color: "var(--fg-dim)" }}>
				<span style={{ color: "var(--acc)" }}>◱</span>
				<b style={{ color: "var(--fg)", fontWeight: 500 }}>{path}</b>
				<span className="font-mono">
					<i style={{ color: "var(--green)", fontStyle: "normal" }}>+{added}</i>{" "}
					<i style={{ color: "var(--red)", fontStyle: "normal" }}>−{removed}</i>
				</span>
				<span style={{ color: "var(--fg-faint)" }}>工作区 ⇄ HEAD · 双全文</span>
				<div className="ml-auto flex items-center gap-1">
					<button className="rounded px-1.5 hover:bg-[var(--bg3)]" title="上一处变更" onClick={() => goTo(cur - 1)}>
						‹
					</button>
					<span className="font-mono text-[10.5px]">
						{chunks.length ? cur + 1 : 0}/{chunkCount}
					</span>
					<button className="rounded px-1.5 hover:bg-[var(--bg3)]" title="下一处变更" onClick={() => goTo(cur + 1)}>
						›
					</button>
					<button
						className="ml-2 rounded border px-2 py-0.5"
						style={{ borderColor: "var(--acc-line)", background: "var(--acc-dim)", color: "var(--acc-text)" }}
						title="把右侧(含中缝应用结果)写回文件"
						onClick={() => void saveRight()}
					>
						应用并保存
					</button>
				</div>
			</div>
			<div ref={hostRef} className="min-h-0 flex-1 overflow-auto" />
		</div>
	);
}
