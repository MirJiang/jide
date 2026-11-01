/**
 * 代码编辑器(CodeMirror 6,可替换抽象:tech-stack §3)
 * 大文件:CM6 自身视口渲染,10MB 级文本打开不卡(验收基线)。
 */

import { useEffect, useRef } from "react";
import { EditorView, keymap, highlightActiveLine, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { indentUnit } from "@codemirror/language";
import { useIDE } from "../store";

const theme = EditorView.theme(
	{
		"&": { height: "100%", backgroundColor: "var(--bg0)", color: "var(--fg)" },
		".cm-gutters": { backgroundColor: "var(--bg0)", color: "var(--fg-faint)", border: "none" },
		".cm-activeLine": { backgroundColor: "rgba(62,207,142,.06)" },
		".cm-activeLineGutter": { backgroundColor: "rgba(62,207,142,.08)", color: "var(--fg)" },
		".cm-content": { fontFamily: '"Cascadia Code","JetBrains Mono",Consolas,monospace', lineHeight: 1.65 },
		".cm-selectionBackground, ::selection": { backgroundColor: "rgba(62,207,142,.25)" },
		".cm-cursor": { borderLeftColor: "var(--acc)", borderLeftWidth: 2 },
	},
	{ dark: true },
);

function langFor(path: string | undefined) {
	if (!path) return [];
	if (/\.(ts|tsx|js|jsx|mjs)$/.test(path)) return [javascript({ typescript: true, jsx: path.endsWith("x") })];
	if (/\.json$/.test(path)) return [json()];
	if (/\.md$/.test(path)) return [markdown()];
	if (/\.html?$/.test(path)) return [html()];
	if (/\.css$/.test(path)) return [css()];
	return [];
}

export function CodeEditor({ path, content }: { path: string; content: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const markDirty = useIDE((s) => s.markDirty);
	const saveActiveTab = useIDE((s) => s.saveActiveTab);
	// 字号来自设置(CM 根元素继承,改字号无需重建编辑器)
	const editorFontSize = useIDE((s) => s.settings?.editorFontSize ?? 12.5);
	const langComp = useRef(new Compartment());

	useEffect(() => {
		if (!hostRef.current) return;
		const state = EditorState.create({
			doc: content,
			extensions: [
				basicSetup,
				theme,
				lineNumbers(),
				highlightActiveLine(),
				highlightActiveLineGutter(),
				indentUnit.of("  "),
				keymap.of([
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							void saveActiveTab();
							return true;
						},
					},
				]),
				langComp.current.of(langFor(path)),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						markDirty(path, update.state.doc.toString());
					}
				}),
			],
		});
		const view = new EditorView({ state, parent: hostRef.current });
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [path]);

	// 外部内容变化(切换页签重挂载由 key 保证;此处处理同 path 重开)
	useEffect(() => {
		const view = viewRef.current;
		if (view && content !== view.state.doc.toString() && view.state.doc.length === 0) {
			view.dispatch({ changes: { from: 0, to: 0, insert: content } });
		}
	}, [content]);

	return <div ref={hostRef} className="h-full overflow-hidden" style={{ fontSize: `${editorFontSize}px` }} />;
}
