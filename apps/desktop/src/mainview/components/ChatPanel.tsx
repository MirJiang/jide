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
						className="absolute bottom-9 left-0 z-50 max-h-[420px] w-[340px] overflow-y-auto rounded-lg border p-1.5"
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
											常用
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

/* ---------------- Composer(标准 agent IDE 输入框:附件/权限/模型/思考/右下发送) ---------------- */

interface Attachment {
	path: string;
	/** 文本内容(内联);二进制/过大为 null(仅路径引用) */
	content: string | null;
	size: number;
	truncated?: boolean;
}

const THINKING_LABEL: Record<string, string> = {
	off: "关闭",
	minimal: "最小",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "超高",
	max: "最大",
};

function Composer({
	input,
	setInput,
	inputRef,
	busy,
}: {
	input: string;
	setInput: (v: string) => void;
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	busy: boolean;
}) {
	const s = useIDE();
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [permission, setPermission] = useState<"auto" | "confirm">("auto");
	const [permissionOpen, setPermissionOpen] = useState(false);
	const [thinking, setThinking] = useState<string>("");
	const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [attachErr, setAttachErr] = useState("");
	const sessId = s.chat.sessionId;

	// 会话就绪后拉一次思考等级目录(模型相关)
	useEffect(() => {
		if (!sessId) return;
		void s.client
			?.request("session.getThinkingLevels", { sessionId: sessId })
			.then((r) => {
				if (r.ok) setThinkingLevels(r.levels);
			})
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessId]);

	const addFiles = async () => {
		setAttachErr("");
		const picked = await s.client?.request("project.pickFile", {});
		if (!picked?.ok || !picked.file) return;
		if (attachments.some((a) => a.path === picked.file)) return;
		const r = await s.client?.request("fs.readAbsolute", { path: picked.file });
		if (!r?.ok) {
			setAttachErr(r?.error ?? "读取失败");
			return;
		}
		// 二进制探测:前 4KB 含 NUL 视为二进制(仅路径引用)
		const head = r.content.slice(0, 4096);
		const binary = head.includes("\u0000");
		setAttachments((a) => [...a, { path: picked.file, content: binary ? null : r.content, size: r.size, truncated: r.truncated }]);
	};

	const doSend = () => {
		let text = input;
		attachments.forEach((a, i) => {
			const name = a.path.split(/[\\/]/).pop();
			text += `\n\n[附件 ${i + 1}:${a.path}]\n`;
			if (a.content !== null) {
				const ext = name?.split(".").pop() ?? "";
				text += `\`\`\`${ext}\n${a.content}${a.truncated ? "\n…(已截断)" : ""}\n\`\`\``;
			} else {
				text += "(二进制文件未内联;如需内容请用 read 工具读取该路径)";
			}
		});
		if (!text.trim()) return;
		setAttachments([]);
		setInput("");
		void useIDE.getState().send(text);
	};

	const autoGrow = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	};

	const toolBtn = "flex h-7 items-center gap-1 rounded px-1.5 text-[11px] hover:bg-[var(--bg2)]";
	const toolStyle = { color: "var(--fg-faint)" } as const;

	return (
		<div className="rounded-xl border p-2" style={{ background: "var(--bg0)", borderColor: "var(--line)" }}>
			{attachments.length > 0 && (
				<div className="mb-1.5 flex flex-wrap gap-1.5">
					{attachments.map((a, i) => (
						<span
							key={a.path + i}
							className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]"
							style={{ borderColor: "var(--acc-line)", background: "var(--acc-dim)", color: "var(--acc-text)" }}
						>
							<Icon name={a.content === null ? "ri-file-3-line" : "ri-file-text-line"} size={11} />
							<span className="max-w-[200px] truncate font-mono">{a.path.split(/[\\/]/).pop()}</span>
							<span style={{ color: "var(--fg-faint)" }}>{Math.max(1, Math.round(a.size / 1024))}KB{a.truncated ? "·截断" : ""}</span>
							<button className="hover:text-[var(--red)]" onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}>
								<Icon name="ri-close-line" size={11} />
							</button>
						</span>
					))}
				</div>
			)}
			{attachErr && (
				<div className="mb-1 text-[11px]" style={{ color: "var(--red)" }}>
					{attachErr}
				</div>
			)}
			<textarea
				ref={(el) => {
					(inputRef as { current: HTMLTextAreaElement | null }).current = el;
					if (el) autoGrow(el);
				}}
				value={input}
				onChange={(e) => {
					setInput(e.target.value);
					autoGrow(e.target);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						doSend();
					}
				}}
				placeholder="向 agent 描述任务…(Enter 发送,Shift+Enter 换行)"
				className="min-h-[52px] w-full resize-none bg-transparent px-1 py-1 outline-none"
				style={{ color: "var(--fg)" }}
			/>
			<div className="mt-1 flex items-center gap-0.5">
				{/* 附件 */}
				<button className={toolBtn} style={toolStyle} title="添加附件(文本内联)" onClick={() => void addFiles()}>
					<Icon name="ri-attachment-line" size={14} />
				</button>
				{/* 权限模式 */}
				<div className="relative">
					<button
						className={toolBtn}
						style={{ color: permission === "confirm" ? "var(--yellow)" : "var(--fg-faint)" }}
						title="权限模式:bash 命令是否先经确认"
						onClick={() => setPermissionOpen((v) => !v)}
					>
						<Icon name={permission === "confirm" ? "ri-shield-flash-line" : "ri-shield-check-line"} size={14} />
						{permission === "confirm" ? "确认" : "自动"}
					</button>
					{permissionOpen && (
						<>
							<div className="fixed inset-0 z-40" onClick={() => setPermissionOpen(false)} />
							<div className="absolute bottom-9 left-0 z-50 w-[200px] rounded-lg border p-1" style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>
								{(
									[
										["auto", "自动执行", "命令直接执行(危险命令仍被安全门禁拦截)"],
										["confirm", "执行前确认", "每条 bash 命令先弹卡确认"],
									] as Array<[string, string, string]>
								).map(([v, lbl, desc]) => (
									<button
										key={v}
										className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-[var(--bg3)]"
										onClick={async () => {
											setPermission(v as "auto" | "confirm");
											setPermissionOpen(false);
											if (sessId) await s.client?.request("session.setPermissionMode", { sessionId: sessId, mode: v });
										}}
									>
										<span className="text-[11.5px]" style={{ color: permission === v ? "var(--acc)" : "var(--fg)" }}>{lbl}</span>
										<span className="text-[10px]" style={{ color: "var(--fg-faint)" }}>{desc}</span>
									</button>
								))}
							</div>
						</>
					)}
				</div>
				{/* 模型 */}
				<ModelPicker />
				{/* 思考等级 */}
				{thinkingLevels.length > 0 && (
					<div className="relative">
						<button className={toolBtn} style={toolStyle} title="思考等级(模型推理深度)" onClick={() => setThinkingOpen((v) => !v)}>
							<Icon name="ri-lightbulb-flash-line" size={14} />
							{thinking ? THINKING_LABEL[thinking] ?? thinking : "默认"}
						</button>
						{thinkingOpen && (
							<>
								<div className="fixed inset-0 z-40" onClick={() => setThinkingOpen(false)} />
								<div className="absolute bottom-9 left-0 z-50 w-[160px] rounded-lg border p-1" style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>
									{thinkingLevels.map((lv) => (
										<button
											key={lv}
											className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] hover:bg-[var(--bg3)]"
											style={{ color: thinking === lv ? "var(--acc)" : "var(--fg)" }}
											onClick={async () => {
												setThinking(lv);
												setThinkingOpen(false);
												if (sessId) await s.client?.request("session.setThinkingLevel", { sessionId: sessId, level: lv });
											}}
										>
											{thinking === lv ? <Icon name="ri-checkbox-circle-fill" size={12} /> : <Icon name="ri-lightbulb-flash-line" size={12} />}
											{THINKING_LABEL[lv] ?? lv}
											<span className="ml-auto font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>{lv}</span>
										</button>
									))}
								</div>
							</>
						)}
					</div>
				)}
				{/* 右侧:重建 / 停止 / 发送 */}
				<div className="ml-auto flex items-center gap-1">
					<button
						title="重建会话(崩溃恢复)"
						onClick={() => void s.rebuild()}
						className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--bg2)]"
						style={{ color: "var(--fg-faint)" }}
					>
						<Icon name="ri-history-line" size={14} />
					</button>
					{busy && (
						<button
							title="停止当前轮次"
							onClick={() => void s.abort()}
							className="flex h-7 items-center gap-1 rounded border px-2 text-[11px] hover:bg-[var(--bg2)]"
							style={{ borderColor: "var(--red)", color: "var(--red)" }}
						>
							<Icon name="ri-stop-circle-line" size={12} />
						</button>
					)}
					<button className="jide-btn flex h-7 items-center gap-1 px-2.5" disabled={busy || (!input.trim() && attachments.length === 0)} onClick={doSend}>
						<Icon name="ri-send-plane-fill" size={13} />
					</button>
				</div>
			</div>
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
			<div ref={feedRef} className="flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[860px] flex-col gap-3">
					{s.chat.messages.length === 0 && !s.chat.streaming && !s.project && (
						<div className="mt-20 flex flex-col items-center gap-5 text-center">
							<PixelJ cell={7} glow title="JIDE" />
							<div>
								<div className="text-[15px] font-semibold" style={{ color: "var(--fg)" }}>
									打开一个项目开始协作
								</div>
							</div>
							<button className="jide-btn px-5 py-2 text-sm" onClick={() => useIDE.getState().setProjectMenuOpen(true)}>
								<Icon name="ri-folder-open-line" size={14} />
								打开项目…
							</button>
						</div>
					)}
					{s.chat.messages.length === 0 && !s.chat.streaming && s.project && (
						<div className="mt-10 text-center text-sm" style={{ color: "var(--fg-faint)" }}>
							发送消息开始对话
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
					<Composer
						input={input}
						setInput={setInput}
						inputRef={inputRef}
						busy={busy}
					/>
				</div>
			</div>
		</div>
	);
}
