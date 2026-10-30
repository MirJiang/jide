/** Agent 对话面板(内容区页签之一;M1 聊天迁移而来) */

import { useEffect, useRef, useState } from "react";
import { useIDE } from "../store";

const STATUS_LABEL: Record<string, string> = {
	idle: "空闲",
	busy: "运行中",
	aborted: "已中断",
	error: "错误",
	disposed: "已销毁",
};

export function ChatPanel() {
	const s = useIDE();
	const [input, setInput] = useState("");
	const feedRef = useRef<HTMLDivElement>(null);
	const busy = s.chat.status === "busy";

	useEffect(() => {
		feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
	}, [s.chat.messages.length, s.chat.streaming]);

	return (
		<div className="flex h-full flex-col">
			<div
				className="flex items-center gap-2 px-4 py-1.5"
				style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}
			>
				<span className="text-xs font-medium" style={{ color: "var(--acc)" }}>✦ 会话</span>
				<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>会话随工作区隔离</span>
				{s.demo && (
					<span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--purple-bg)", color: "var(--purple)" }}>
						demo · faux
					</span>
				)}
				<span className="ml-auto text-[11px]" style={{ color: "var(--fg-dim)" }}>{s.chat.modelLabel}</span>
			</div>
			<div
				className="flex items-center gap-2 px-4 py-1 text-xs"
				style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)", color: "var(--fg-dim)" }}
			>
				<span
					className="inline-block h-2 w-2 rounded-full"
					style={{ background: busy ? "var(--green)" : "var(--fg-faint)", animation: busy ? "jide-pulse 1s infinite" : undefined }}
				/>
				{STATUS_LABEL[s.chat.status] ?? s.chat.status}
				<span style={{ color: "var(--fg-faint)" }}>
					{s.chat.sessionId ? ` · ${s.chat.sessionId.slice(0, 8)}` : ""}
				</span>
				<div className="ml-auto flex gap-2">
					<button
						onClick={() => void s.abort()}
						disabled={!busy}
						className="rounded border px-2 py-0.5 disabled:opacity-40"
						style={{ borderColor: "var(--red)", color: "var(--red)" }}
					>
						停止
					</button>
					<button
						onClick={() => void s.rebuild()}
						className="rounded border px-2 py-0.5"
						style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
					>
						重建会话
					</button>
				</div>
			</div>

			<div ref={feedRef} className="flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[860px] flex-col gap-3">
					{s.chat.messages.length === 0 && !s.chat.streaming && (
						<div className="mt-10 text-center text-sm" style={{ color: "var(--fg-faint)" }}>
							{s.project ? "发送一句话,走通 UI → 宿主 → pi 全链路" : "请先打开项目(左上角)"}
						</div>
					)}
					{s.chat.messages.map((m) =>
						m.role === "user" ? (
							<div
								key={m.id}
								className="self-end rounded-xl rounded-br-sm border px-3 py-2"
								style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#e3edff", maxWidth: 640 }}
							>
								{m.text}
							</div>
						) : (
							<div
								key={m.id}
								className="self-start rounded-lg border px-3 py-2"
								style={{
									background: "var(--bg2)",
									borderColor: "var(--line)",
									color: m.tool ? "var(--fg-dim)" : "var(--fg)",
									fontFamily: m.tool ? "Consolas, monospace" : undefined,
									fontSize: m.tool ? 12 : undefined,
									maxWidth: 840,
								}}
							>
								{m.tool && <span style={{ color: m.toolError ? "var(--red)" : "var(--acc)" }}>⚙ </span>}
								{m.text}
							</div>
						),
					)}
					{s.chat.streaming && (
						<div
							className="self-start rounded-lg border px-3 py-2"
							style={{ background: "var(--bg2)", borderColor: "var(--line)", maxWidth: 840 }}
						>
							{s.chat.streaming}
							<span className="animate-pulse">▍</span>
						</div>
					)}
				</div>
			</div>

			<div className="px-5 pb-3">
				<div className="mx-auto max-w-[860px] rounded-xl border p-2" style={{ background: "var(--bg0)", borderColor: "var(--line)" }}>
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								const t = input;
								setInput("");
								void s.send(t);
							}
						}}
						placeholder="向 agent 描述任务…(Enter 发送)"
						className="h-10 w-full resize-none bg-transparent outline-none"
						style={{ color: "var(--fg)" }}
					/>
					<div className="flex items-center gap-2">
						<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>seq {s.lastSeq}</span>
						<button
							onClick={() => {
								const t = input;
								setInput("");
								void s.send(t);
							}}
							disabled={busy || !input.trim()}
							className="ml-auto rounded-md border px-3 py-1 disabled:opacity-40"
							style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#dbe7ff" }}
						>
							发送
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
