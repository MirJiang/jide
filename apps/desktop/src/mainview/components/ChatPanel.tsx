/** Agent 对话面板(内容区页签之一;M1 聊天迁移而来) */

import { useEffect, useRef, useState } from "react";
import { useIDE } from "../store";
import { parseModelKey } from "@jide/contracts";
import { MemorySuggestionCard } from "./MemoryPanel";
import { PixelJ } from "./PixelJ";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { Virtuoso } from "react-virtuoso";

/** pi 扩展 UI 请求卡片(RPC Extension UI 子协议:select/confirm/input/editor) */
function ExtensionUICards() {
	const requests = useIDE((s) => s.uiRequests);
	const respondUI = useIDE((s) => s.respondUI);
	if (!requests.length) return null;
	return (
		<div className="flex flex-col gap-2">
			{requests.map((u) => (
				<ExtensionUICard key={u.requestId} req={u} onRespond={respondUI} />
			))}
		</div>
	);
}

function ExtensionUICard({
	req,
	onRespond,
}: {
	req: NonNullable<ReturnType<typeof useIDE.getState>["uiRequests"]>[number];
	onRespond: (
		requestId: string,
		resp: { value?: string; confirmed?: boolean; cancelled?: boolean },
	) => Promise<void>;
}) {
	const [value, setValue] = useState(req.prefill ?? "");
	return (
		<div
			className="rounded-lg border px-3 py-2.5"
			style={{ background: "var(--bg1)", borderColor: "var(--acc-line)" }}
		>
			<div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--acc-text)" }}>
				<Icon name="ri-question-answer-line" size={13} />
				{req.title ?? "Agent 请求输入"}
			</div>
			{req.message && (
				<div className="mt-1 text-xs" style={{ color: "var(--fg-dim)" }}>
					{req.message}
				</div>
			)}
			{req.method === "select" && (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{(req.options ?? []).map((opt) => (
						<button key={opt} className="jide-btn px-2.5 py-1 text-xs" onClick={() => void onRespond(req.requestId, { value: opt })}>
							{opt}
						</button>
					))}
				</div>
			)}
			{req.method === "confirm" && (
				<div className="mt-2 flex gap-1.5">
					<button className="jide-btn px-2.5 py-1 text-xs" onClick={() => void onRespond(req.requestId, { confirmed: true })}>
						确认
					</button>
					<button
						className="rounded border px-2.5 py-1 text-xs hover:bg-[var(--bg2)]"
						style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
						onClick={() => void onRespond(req.requestId, { confirmed: false })}
					>
						拒绝
					</button>
				</div>
			)}
			{(req.method === "input" || req.method === "editor") && (
				<div className="mt-2 flex flex-col gap-1.5">
					{req.method === "input" ? (
						<input
							autoFocus
							value={value}
							onChange={(e) => setValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void onRespond(req.requestId, { value });
							}}
							className="rounded border bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--acc)]"
							style={{ borderColor: "var(--line)", color: "var(--fg)" }}
						/>
					) : (
						<textarea
							autoFocus
							value={value}
							onChange={(e) => setValue(e.target.value)}
							rows={4}
							className="rounded border bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--acc)]"
							style={{ borderColor: "var(--line)", color: "var(--fg)" }}
						/>
					)}
					<div className="flex gap-1.5">
						<button className="jide-btn px-2.5 py-1 text-xs" onClick={() => void onRespond(req.requestId, { value })}>
							提交
						</button>
						<button
							className="rounded border px-2.5 py-1 text-xs hover:bg-[var(--bg2)]"
							style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
							onClick={() => void onRespond(req.requestId, { cancelled: true })}
						>
							取消
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** 模型选择器:常用(settings.favoriteModels)+ 全部目录(pi get_available_models);切换即 set_model */
function ModelPicker() {
	const s = useIDE();
	const [open, setOpen] = useState(false);
	const favorites = s.settings?.favoriteModels ?? [];
	const catalog = s.modelCatalog;

	// 首次展开拉目录(宿主缓存 5min,无感)
	useEffect(() => {
		if (open && catalog.length === 0) void s.refreshModels();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const pick = (key: string) => {
		const parsed = parseModelKey(key);
		setOpen(false);
		if (parsed) void s.setSessionModel(parsed.provider, parsed.modelId);
	};

	const item = (key: string, name: string, sub: string) => {
		const active = s.chat.modelLabel === name;
		return (
			<button
				key={key}
				className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-[var(--bg3)]"
				style={{ color: active ? "var(--acc)" : "var(--fg)" }}
				onClick={() => pick(key)}
			>
				<Icon name={active ? "ri-checkbox-circle-fill" : "ri-model-2-line"} size={13} />
				<span className="truncate">{name}</span>
				<span className="ml-auto truncate font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>
					{sub}
				</span>
			</button>
		);
	};

	if (!s.chat.sessionId) {
		return <span className="text-[11px]" style={{ color: "var(--fg-dim)" }}>{s.chat.modelLabel || "—"}</span>;
	}

	return (
		<div className="relative">
			<button
				className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--bg2)]"
				style={{ color: "var(--fg-dim)" }}
				title="切换模型(对当前会话即时生效)"
				onClick={() => setOpen((v) => !v)}
			>
				<Icon name="ri-sparkling-2-line" size={12} color="var(--acc)" />
				<span className="max-w-[220px] truncate">{s.chat.modelLabel || "选择模型"}</span>
				<Icon name="ri-arrow-down-s-line" size={12} />
			</button>
			{open && (
				<>
					<div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
					<div
						className="absolute right-0 top-7 z-50 max-h-[420px] w-[340px] overflow-y-auto rounded-lg border p-1.5"
						style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}
					>
						{catalog.length === 0 ? (
							<div className="px-2.5 py-3 text-xs" style={{ color: "var(--fg-faint)" }}>
								{s.modelCatalogLoading ? "正在读取 pi 模型目录…" : "目录为空:请确认 ~/.pi 已配置模型后重试"}
							</div>
						) : (
							<>
								{favorites.length > 0 && (
									<>
										<div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
											常用(设置 → 模型)
										</div>
										{favorites.map((k) => {
											const m = catalog.find((x) => x.key === k);
											return item(k, m?.name ?? k, m ? `${m.provider}/${m.id}` : k);
										})}
										<div className="my-1" style={{ borderTop: "1px solid var(--line)" }} />
									</>
								)}
								<div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
									全部(pi ~/.pi 模型目录)
								</div>
								{catalog.map((m) => item(m.key, m.name, m.key))}
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
}

export function ChatPanel() {
	const s = useIDE();
	const [input, setInput] = useState("");
	const feedRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const busy = s.chat.status === "busy";

	useEffect(() => {
		feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
	}, [s.chat.messages.length, s.chat.streaming]);

	// 外部投递(终端/测试/评审 →「问 agent」):上下文预填输入框,聚焦待用户确认发送
	useEffect(() => {
		if (!s.chatPrefill) return;
		setInput(s.chatPrefill);
		useIDE.setState({ chatPrefill: null });
		inputRef.current?.focus();
	}, [s.chatPrefill]);

	return (
		<div className="flex h-full flex-col">
			<div
				className="flex items-center gap-2 px-4 py-1.5"
				style={{ background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}
			>
				<PixelJ cell={2.5} busy={busy} glow title="JIDE Agent" />
					<span className="text-xs font-medium" style={{ color: "var(--acc)" }}>会话</span>
					<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>会话随工作区隔离</span>
					<div className="ml-auto"><ModelPicker /></div>
				<button
					onClick={() => void s.abort()}
					disabled={!busy}
					className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-[var(--bg2)] disabled:opacity-40"
					style={{ borderColor: "var(--red)", color: "var(--red)" }}
				>
					<Icon name="ri-stop-circle-line" size={12} />
					停止
				</button>
				<button
					onClick={() => void s.rebuild()}
					className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-[var(--bg2)]"
					style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
				>
					<Icon name="ri-history-line" size={12} />
					重建会话
				</button>
			</div>

			<div ref={feedRef} className="flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[860px] flex-col gap-3">
					{s.chat.messages.length === 0 && !s.chat.streaming && !s.project && (
						<div className="mt-20 flex flex-col items-center gap-5 text-center">
							<PixelJ cell={7} glow title="JIDE" />
							<div>
								<div className="text-[15px] font-semibold" style={{ color: "var(--fg)" }}>
									打开一个项目开始协作
								</div>
								<div className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--fg-faint)" }}>
									选择一个 git 仓库,agent 帮你改代码、跑测试、自动提交
								</div>
							</div>
							<button className="jide-btn px-5 py-2 text-sm" onClick={() => useIDE.getState().setProjectMenuOpen(true)}>
								<Icon name="ri-folder-open-line" size={14} />
								打开项目…
							</button>
							<div className="flex items-center gap-1 text-[11px]" style={{ color: "var(--fg-faint)" }}>
								<Icon name="ri-information-line" size={12} />
								也可以从标题栏「项目」下拉随时打开(本地 / 远程)
							</div>
						</div>
					)}
					{s.chat.messages.length === 0 && !s.chat.streaming && s.project && (
						<div className="mt-10 text-center text-sm" style={{ color: "var(--fg-faint)" }}>
							发送一句话,走通 UI → 宿主 → pi 全链路
						</div>
					)}
					{s.chat.messages.map((m) =>
						m.role === "user" ? (
							<div
								key={m.id}
								className="self-end rounded-xl rounded-br-sm border px-3 py-2"
								style={{ background: "var(--acc-dim)", borderColor: "var(--acc-line)", color: "var(--acc-text)", maxWidth: 640 }}
							>
								{m.text}
							</div>
						) : (
							<div key={m.id} className="flex items-start gap-2 self-start" style={{ maxWidth: 880 }}>
								<div className="pt-1.5">
									<PixelJ
										cell={2.5}
										busy={busy && m.id === s.chat.messages[s.chat.messages.length - 1]?.id && !m.tool}
										title="JIDE Agent"
									/>
								</div>
								<div
									className="rounded-lg border px-3 py-2"
									style={{
										background: "var(--bg2)",
										borderColor: "var(--line)",
										color: m.tool ? "var(--fg-dim)" : "var(--fg)",
										fontFamily: m.tool ? "Consolas, monospace" : undefined,
										fontSize: m.tool ? 12 : undefined,
										maxWidth: 840,
									}}
								>
									{m.tool && (
										<span className="inline-flex items-center gap-1" style={{ color: m.toolError ? "var(--red)" : "var(--acc)" }}>
											<Icon name={m.toolError ? "ri-error-warning-line" : "ri-route-line"} size={12} />
										</span>
									)}
									{m.tool ? m.text : <Markdown text={m.text} />}
								</div>
							</div>
						),
					)}
					{s.memorySuggestions.map((sg) => (
						<MemorySuggestionCard key={sg.suggestionId} suggestion={sg} />
					))}
					{s.chat.streaming && (
						<div className="flex items-start gap-2 self-start" style={{ maxWidth: 880 }}>
							<div className="pt-1.5">
								<PixelJ cell={2.5} busy title="JIDE Agent" />
							</div>
							<div
								className="rounded-lg border px-3 py-2"
								style={{ background: "var(--bg2)", borderColor: "var(--line)", maxWidth: 840 }}
							>
								{s.chat.streaming}
								<span className="animate-pulse">▍</span>
							</div>
						</div>
					)}
				</div>
			</div>

			<div className="px-5 pb-3">
				<div className="mx-auto flex max-w-[860px] flex-col gap-2">
					<ExtensionUICards />
					<div className="rounded-xl border p-2" style={{ background: "var(--bg0)", borderColor: "var(--line)" }}>
					<textarea
						ref={inputRef}
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
							className="jide-btn ml-auto px-3 py-1"
						>
							发送
							<Icon name="ri-send-plane-fill" size={12} />
						</button>
					</div>
					</div>
				</div>
			</div>
		</div>
	);
}
