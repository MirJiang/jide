/**
 * M1 界面:单会话聊天页(对话=内容区页签的雏形;M2 再扩成完整 IDE 布局)
 * 验收路径:连接 → 发消息 → 流式渲染 → 停止 → 重建
 */

import { useEffect, useRef, useState } from "react";
import { useJide } from "./store";
import { connect } from "./rpc";

const STATUS_LABEL: Record<string, string> = {
	idle: "空闲",
	busy: "运行中",
	aborted: "已中断",
	error: "错误",
	disposed: "已销毁",
};

function App() {
	const s = useJide();
	const [input, setInput] = useState("");
	const feedRef = useRef<HTMLDivElement>(null);
	const bootedRef = useRef(false);

	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		const client = connect((event) => useJide.getState().handleEvent(event));
		client.resync(0);
		useJide.getState().connect(client).catch((err) => {
			useJide.setState((st) => ({ logs: [...st.logs, `连接失败:${err}`] }));
		});
	}, []);

	useEffect(() => {
		feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
	}, [s.messages.length, s.streaming]);

	const busy = s.status === "busy";

	return (
		<div className="flex h-full flex-col" style={{ background: "var(--bg0)" }}>
			{/* 顶栏 */}
			<header
				className="flex items-center gap-3 px-4 py-2"
				style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}
			>
				<span className="font-semibold tracking-wide" style={{ color: "var(--acc)" }}>
					JIDE
				</span>
				<span className="text-xs" style={{ color: "var(--fg-faint)" }}>
					{s.connected ? `${s.hostName} · protocol v${s.protocolVersion}` : "连接中…"}
				</span>
				{s.demo && (
					<span
						className="rounded px-1.5 py-0.5 text-[10px]"
						style={{ background: "rgba(196,181,253,.12)", color: "var(--purple)" }}
					>
						demo · faux
					</span>
				)}
				<span className="ml-auto text-xs" style={{ color: "var(--fg-dim)" }}>
					{s.modelLabel}
				</span>
			</header>

			{/* 会话状态条 */}
			<div
				className="flex items-center gap-2 px-4 py-1.5 text-xs"
				style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)", color: "var(--fg-dim)" }}
			>
				<span
					className="inline-block h-2 w-2 rounded-full"
					style={{
						background: busy
							? "var(--green)"
							: s.status === "error"
								? "var(--red)"
								: "var(--fg-faint)",
						animation: busy ? "pulse 1s infinite" : undefined,
					}}
				/>
				<span>{STATUS_LABEL[s.status] ?? s.status}</span>
				<span className="truncate" style={{ color: "var(--fg-faint)" }}>
					{s.sessionId ? `会话 ${s.sessionId.slice(0, 8)}` : ""}
				</span>
				<div className="ml-auto flex gap-2">
					<button
						onClick={() => s.abort()}
						disabled={!busy}
						className="rounded border px-2 py-0.5 disabled:opacity-40"
						style={{ borderColor: "var(--red)", color: "var(--red)" }}
					>
						停止
					</button>
					<button
						onClick={() => s.rebuild()}
						className="rounded border px-2 py-0.5"
						style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
					>
						重建会话
					</button>
				</div>
			</div>

			{/* 消息流 */}
			<div ref={feedRef} className="flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[860px] flex-col gap-3">
					{s.messages.length === 0 && !s.streaming && (
						<div className="mt-10 text-center text-sm" style={{ color: "var(--fg-faint)" }}>
							发送一句话,走通 UI → 宿主 → pi 全链路(demo 模式本地演练)
						</div>
					)}
					{s.messages.map((m) =>
						m.role === "user" ? (
							<div
								key={m.id}
								className="self-end rounded-xl rounded-br-sm border px-3 py-2"
								style={{
									background: "var(--acc-dim)",
									borderColor: "#4a6db3",
									color: "#e3edff",
									maxWidth: 640,
								}}
							>
								{m.text}
							</div>
						) : (
							<div
								key={m.id}
								className="self-start rounded-lg border px-3 py-2"
								style={{
									background: "var(--bg2)",
									borderColor: m.tool ? "var(--line)" : "var(--line)",
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
					{s.streaming && (
						<div
							className="self-start rounded-lg border px-3 py-2"
							style={{ background: "var(--bg2)", borderColor: "var(--line)", maxWidth: 840 }}
						>
							{s.streaming}
							<span className="animate-pulse">▍</span>
						</div>
					)}
				</div>
			</div>

			{/* 输入区 */}
			<div className="px-5 pb-4">
				<div
					className="mx-auto max-w-[860px] rounded-xl border p-2"
					style={{ background: "var(--bg0)", borderColor: "var(--line)" }}
				>
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
					 onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								const text = input;
								setInput("");
								s.send(text);
							}
						}}
						placeholder="向 agent 描述任务…(Enter 发送)"
						className="h-10 w-full resize-none bg-transparent outline-none"
						style={{ color: "var(--fg)" }}
					/>
					<div className="flex items-center gap-2">
						<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>
							seq {s.lastSeq}
						</span>
						<button
							onClick={() => {
								const text = input;
								setInput("");
								s.send(text);
							}}
							disabled={busy || !input.trim()}
							className="ml-auto rounded-md border px-3 py-1 disabled:opacity-40"
							style={{ background: "var(--acc-dim)", borderColor: "#4a6db3", color: "#dbe7ff" }}
						>
							发送
						</button>
					</div>
				</div>
				{s.logs.length > 0 && (
					<div
						className="mx-auto mt-2 max-w-[860px] truncate text-[11px]"
						style={{ color: "var(--fg-faint)" }}
						title={s.logs[s.logs.length - 1]}
					>
						{s.logs[s.logs.length - 1]}
					</div>
				)}
			</div>

			<style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
		</div>
	);
}

export default App;
