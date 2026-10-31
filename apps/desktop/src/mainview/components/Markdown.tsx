/**
 * Markdown — agent 消息渲染(react-markdown + remark-gfm + shiki 代码高亮)
 * shiki 为懒加载单例(首次代码块到达时初始化;失败回退纯文本样式)。
 */

import { useEffect, useState } from "react";

export function Markdown({ text }: { text: string }) {
	return <Md text={text} />;
}

function Md({ text }: { text: string }) {
	const Mod = useMdModules();
	if (!Mod) return <div className="md-body">{text}</div>;
	const { ReactMarkdown, remarkGfm } = Mod;
	return (
		<div className="md-body">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
				{text}
			</ReactMarkdown>
		</div>
	);
}

let mdModules: { ReactMarkdown: any; remarkGfm: any } | null = null;
function useMdModules() {
	const [mod, setMod] = useState(mdModules);
	useEffect(() => {
		if (mdModules) return;
		void Promise.all([import("react-markdown"), import("remark-gfm")]).then(([rm, rg]) => {
			mdModules = { ReactMarkdown: rm.default, remarkGfm: rg.default };
			setMod(mdModules);
		});
	}, []);
	return mod;
}

/** 代码块:shiki 高亮(懒加载;失败回退) */
function CodeBlock({ className, children, ...rest }: any) {
	const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
	const code = String(children);
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		if (!isBlock) return;
		let alive = true;
		void (async () => {
			try {
				const shiki = await getShiki();
				const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "ts";
				const out = await shiki.codeToHtml(code, {
					lang: SHIKI_LANGS.includes(lang) ? lang : "ts",
					theme: "github-dark-default",
				});
				if (alive) setHtml(out);
			} catch {
				/* 回退纯文本 */
			}
		})();
		return () => {
			alive = false;
		};
	}, [code, className, isBlock]);

	if (!isBlock) return <code {...rest}>{children}</code>;
	if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />;
	return (
		<pre>
			<code>{code}</code>
		</pre>
	);
}

const SHIKI_LANGS = ["ts", "tsx", "js", "jsx", "json", "md", "css", "html", "bash", "sh", "py"] as const;

let shikiPromise: Promise<any> | null = null;
async function getShiki() {
	if (!shikiPromise) {
		shikiPromise = import("shiki").then((m) =>
			m.createHighlighter({ themes: ["github-dark-default"], langs: [...SHIKI_LANGS] as any }),
		);
	}
	return shikiPromise;
}
