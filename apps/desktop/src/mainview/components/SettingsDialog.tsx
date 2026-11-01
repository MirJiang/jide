/**
 * 设置对话框:左分组导航 + 右内容区(布局参照冻结原型族)
 * 设置持久化在宿主(~/.jide/settings.json),改动经 saveSettings 即时下发;
 * 提供方页的密钥走系统凭据库(credential.*,值永不回传 UI)。
 */

import { useEffect, useState } from "react";
import { useIDE } from "../store";
import { PROTOCOL_VERSION } from "@jide/contracts";
import type { JideSettings } from "@jide/contracts";
import { Icon } from "./Icon";

type Category = "model" | "providers" | "devserver" | "appearance" | "terminal" | "about";

const NAV: Array<{ group: string; items: Array<{ id: Category; label: string; icon: string }> }> = [
	{
		group: "AGENT",
		items: [
			{ id: "model", label: "模型", icon: "ri-sparkling-2-line" },
			{ id: "providers", label: "提供方", icon: "ri-key-2-line" },
			{ id: "devserver", label: "Dev 服务器", icon: "ri-server-line" },
		],
	},
	{
		group: "界面",
		items: [{ id: "appearance", label: "外观", icon: "ri-contrast-line" }],
	},
	{
		group: "系统",
		items: [
			{ id: "terminal", label: "终端", icon: "ri-terminal-box-line" },
			{ id: "about", label: "关于", icon: "ri-information-line" },
		],
	},
];

export function SettingsDialog() {
	const s = useIDE();
	const [cat, setCat] = useState<Category>("model");

	useEffect(() => {
		if (!s.settingsOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") useIDE.getState().setSettingsOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [s.settingsOpen]);

	if (!s.settingsOpen) return null;

	return (
		<div
			className="absolute inset-0 z-[100] flex items-center justify-center"
			style={{ background: "rgba(8,10,14,.72)", backdropFilter: "blur(3px)" }}
			onClick={(e) => {
				if (e.target === e.currentTarget) s.setSettingsOpen(false);
			}}
		>
			<div
				className="flex h-[560px] w-[860px] flex-col overflow-hidden rounded-2xl border"
				style={{ background: "var(--bg1)", borderColor: "var(--line2)", boxShadow: "0 30px 80px rgba(0,0,0,.6)" }}
			>
				{/* 标题栏 */}
				<div
					className="flex h-[42px] flex-none items-center justify-between px-4"
					style={{ borderBottom: "1px solid var(--line)", background: "var(--bg1)" }}
				>
					<span className="flex items-center gap-2 text-sm font-semibold">
						<Icon name="ri-settings-3-line" size={15} color="var(--acc)" />
						设置
					</span>
					<button
						className="flex items-center rounded px-1.5 hover:text-[var(--fg)]"
						style={{ color: "var(--fg-faint)" }}
						title="关闭(Esc)"
						onClick={() => s.setSettingsOpen(false)}
					>
						<Icon name="ri-close-line" size={15} />
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					{/* 左:分组导航 */}
					<nav
						className="flex w-[196px] flex-none flex-col overflow-y-auto py-2"
						style={{ background: "var(--bg1)", borderRight: "1px solid var(--line)" }}
					>
						{NAV.map((g) => (
							<div key={g.group} className="mb-1">
								<div className="px-3.5 pb-1 pt-2.5 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
									{g.group}
								</div>
								{g.items.map((it) => {
									const active = cat === it.id;
									return (
										<button
											key={it.id}
											className="relative flex w-full items-center gap-2 px-3.5 py-[7px] text-left text-xs"
											style={{
												color: active ? "var(--acc)" : "var(--fg-dim)",
												background: active ? "var(--bg3)" : undefined,
											}}
											onClick={() => setCat(it.id)}
										>
											{active && <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: "var(--acc)" }} />}
											<i
												className={`${it.icon} text-[15px] leading-none`}
												style={{ color: active ? "var(--acc)" : "var(--fg-faint)" }}
												aria-hidden
											/>
											{it.label}
										</button>
									);
								})}
							</div>
						))}
					</nav>
					{/* 右:内容区 */}
					<div className="min-w-0 flex-1 overflow-y-auto p-6" style={{ background: "var(--bg0)" }}>
						{!s.settings ? (
							<div className="mt-16 text-center text-sm" style={{ color: "var(--fg-faint)" }}>
								设置加载中…
							</div>
						) : (
							<>
								{cat === "model" && <ModelPage onNavigate={setCat} />}
								{cat === "providers" && <ProvidersPage />}
								{cat === "devserver" && <DevserverPage />}
								{cat === "appearance" && <AppearancePage />}
								{cat === "terminal" && <TerminalPage />}
								{cat === "about" && <AboutPage />}
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ---------------- 通用小件 ---------------- */

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-6 py-3" style={{ borderBottom: "1px solid var(--line)" }}>
			<div className="min-w-0">
				<div className="text-[13px]" style={{ color: "var(--fg)" }}>{label}</div>
				{desc && (
					<div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>{desc}</div>
				)}
			</div>
			<div className="flex flex-none items-center gap-2">{children}</div>
		</div>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<div className="mb-2 mt-1 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
			{children}
		</div>
	);
}

function Select({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none"
			style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
		>
			{options.map(([v, label]) => (
				<option key={v} value={v} style={{ background: "var(--bg2)" }}>
					{label}
				</option>
			))}
		</select>
	);
}

function NumInput({ value, min, max, step, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
	return (
		<input
			type="number"
			value={value}
			min={min}
			max={max}
			step={step}
			onChange={(e) => {
				const n = Number(e.target.value);
				if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
			}}
			className="w-[72px] rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none"
			style={{ borderColor: "var(--line2)", color: "var(--fg)" }}
		/>
	);
}

function TextInput({ value, placeholder, mono, width, onChange }: { value: string; placeholder?: string; mono?: boolean; width?: number; onChange: (v: string) => void }) {
	return (
		<input
			value={value}
			placeholder={placeholder}
			onChange={(e) => onChange(e.target.value)}
			className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none"
			style={{
				borderColor: "var(--line2)",
				color: "var(--fg)",
				width: width ? `${width}px` : undefined,
				fontFamily: mono ? "Consolas, monospace" : undefined,
			}}
		/>
	);
}

/* ---------------- 各分类页 ---------------- */

function ModelPage({ onNavigate }: { onNavigate: (c: Category) => void }) {
	const s = useIDE();
	const st = s.settings!;
	const catalog = s.modelCatalog;
	const favorites = st.favoriteModels;

	useEffect(() => {
		if (catalog.length === 0) void s.refreshModels();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const saveFavorites = (next: string[]) => void s.saveSettings({ favoriteModels: next });

	const move = (i: number, d: -1 | 1) => {
		const next = [...favorites];
		const j = i + d;
		if (j < 0 || j >= next.length) return;
		[next[i], next[j]] = [next[j], next[i]];
		saveFavorites(next);
	};

	const nameOf = (key: string) => catalog.find((m) => m.key === key)?.name ?? key;

	const addFavorite = (key: string) => {
		if (!favorites.includes(key)) saveFavorites([...favorites, key]);
	};

	return (
		<div>
			<SectionTitle>模型</SectionTitle>
			<div className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
				目录读取自 pi(<span style={{ color: "var(--fg-dim)" }}>~/.pi</span> 模型配置,新增自定义模型请在 pi 侧配置)。
				常用模型按序展示于对话面板顶部选择器,切换对当前会话即时生效;默认模型用于新会话。
			</div>

			<Row label="新会话默认模型" desc="空 = pi 自己的默认(不传 --model)">
				<Select
					value={st.defaultModel}
					options={[["", "(pi 默认)"], ...favorites.map((k) => [k, nameOf(k)] as [string, string])]}
					onChange={(v) => void s.saveSettings({ defaultModel: v })}
				/>
			</Row>

			<Row label="编排模式" desc="会话获得委派工具(spawn_worker 等):agent 可把子任务拆给 Worker 池并行执行,完成后结果自动回喂;关闭则单会话直驱">
				<Select
					value={st.orchestrator ? "1" : "0"}
					options={[
						["1", "开启"],
						["0", "关闭"],
					]}
					onChange={(v) => void s.saveSettings({ orchestrator: v === "1" })}
				/>
			</Row>
			<Row label="开机自启" desc="登录 Windows 后自动启动 JIDE(写入注册表 Run 键;仅打包安装态生效,源码运行态自动跳过)">
				<Select
					value={st.autostart ? "1" : "0"}
					options={[
						["1", "开启"],
						["0", "关闭"],
					]}
					onChange={(v) => void s.saveSettings({ autostart: v === "1" })}
				/>
			</Row>

			<div className="mb-2 mt-4 flex items-center justify-between">
				<span className="text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
					常用模型({favorites.length})
				</span>
				<button
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--bg2)]"
					style={{ color: "var(--fg-faint)" }}
					disabled={s.modelCatalogLoading}
					onClick={() => void s.refreshModels(true)}
				>
					<Icon name={s.modelCatalogLoading ? "ri-loader-4-line" : "ri-refresh-line"} size={12} className={s.modelCatalogLoading ? "animate-spin" : ""} />
					刷新目录
				</button>
			</div>
			{favorites.length === 0 && (
				<div className="py-2 text-xs" style={{ color: "var(--fg-faint)" }}>
					尚未配置。从下方目录把常用模型加进来,即可在对话面板随时切换。
				</div>
			)}
			{favorites.map((k, i) => (
				<Row key={k} label={nameOf(k)} desc={k}>
					<button
						className="flex items-center rounded px-1 py-0.5 hover:bg-[var(--bg2)] disabled:opacity-30"
						style={{ color: "var(--fg-dim)" }}
						title="上移"
						disabled={i === 0}
						onClick={() => move(i, -1)}
					>
						<Icon name="ri-arrow-up-line" size={13} />
					</button>
					<button
						className="flex items-center rounded px-1 py-0.5 hover:bg-[var(--bg2)] disabled:opacity-30"
						style={{ color: "var(--fg-dim)" }}
						title="下移"
						disabled={i === favorites.length - 1}
						onClick={() => move(i, 1)}
					>
						<Icon name="ri-arrow-down-line" size={13} />
					</button>
					<button
						className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-[var(--bg2)]"
						style={{ borderColor: "var(--red)", color: "var(--red)" }}
						onClick={() => {
							const next = favorites.filter((x) => x !== k);
							saveFavorites(next);
							// 默认模型被移除则一并清空
							if (st.defaultModel === k) void s.saveSettings({ defaultModel: "" });
						}}
					>
						<Icon name="ri-close-line" size={12} />
						移除
					</button>
				</Row>
			))}

			<div className="mb-2 mt-5 text-[10px] font-semibold tracking-wider" style={{ color: "var(--fg-faint)" }}>
				从目录添加({catalog.length})
			</div>
			{catalog.length === 0 ? (
				<div className="py-2 text-xs" style={{ color: "var(--fg-faint)" }}>
					{s.modelCatalogLoading ? "正在读取 pi 模型目录(拉起临时 pi 进程,约 1-3 秒)…" : "目录为空:请先在 pi 侧完成模型配置(或认证后重试)"}
				</div>
			) : (
				<div className="max-h-[180px] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--line)" }}>
					{catalog.map((m) => {
						const added = favorites.includes(m.key);
						return (
							<div key={m.key} className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid var(--line)" }}>
								<span className="truncate text-xs" style={{ color: "var(--fg)" }}>{m.name}</span>
								<span className="truncate font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>{m.key}</span>
								{m.reasoning && (
									<span className="rounded px-1 py-px text-[9px]" style={{ background: "var(--acc-dim)", color: "var(--acc-text)" }}>推理</span>
								)}
								<button
									className="ml-auto flex flex-none items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg2)] disabled:opacity-40"
									style={{ borderColor: added ? "var(--line)" : "var(--acc-line)", color: added ? "var(--fg-faint)" : "var(--acc)" }}
									disabled={added}
									onClick={() => addFavorite(m.key)}
								>
									<Icon name={added ? "ri-checkbox-circle-line" : "ri-add-line"} size={12} />
									{added ? "已添加" : "添加"}
								</button>
							</div>
						);
					})}
				</div>
			)}

			<Row label="提供方密钥" desc="pi 侧认证(~/.pi/auth.json)与系统凭据库">
				<button
					className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-[var(--bg2)]"
					style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
					onClick={() => onNavigate("providers")}
				>
					前往管理
					<Icon name="ri-arrow-right-s-line" size={13} />
				</button>
			</Row>
		</div>
	);
}

function ProvidersPage() {
	const s = useIDE();
	const [names, setNames] = useState<string[] | null>(null);
	const [err, setErr] = useState("");
	const [newName, setNewName] = useState("");
	const [newSecret, setNewSecret] = useState("");

	const refresh = async () => {
		const r = await s.client?.request("credential.list", {});
		if (r && r.ok) setNames(r.names);
		else setErr(r && !r.ok ? r.error : "未连接宿主");
	};
	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div>
			<SectionTitle>提供方</SectionTitle>
			<div className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
				真实模式的模型与凭据当前读取 ~/.pi(auth.json / models-store.json)。下列密钥库写入
				<span style={{ color: "var(--fg-dim)" }}>系统凭据管理器</span>
				(Windows PasswordVault,值不出库、不回传),为后续 provider 直连预留。
			</div>
			{names === null ? (
				<div className="py-3 text-xs" style={{ color: "var(--fg-faint)" }}>读取凭据库…</div>
			) : names.length === 0 ? (
				<div className="py-3 text-xs" style={{ color: "var(--fg-faint)" }}>暂无已存密钥</div>
			) : (
				names.map((n) => (
					<Row key={n} label={n} desc="已存入系统凭据库">
						<button
							className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-[var(--bg2)]"
							style={{ borderColor: "var(--red)", color: "var(--red)" }}
							onClick={async () => {
								await s.client?.request("credential.delete", { name: n });
								void refresh();
							}}
						>
							<Icon name="ri-delete-bin-line" size={12} />
							删除
						</button>
					</Row>
				))
			)}
			<div className="mt-4 flex items-center gap-2">
				<TextInput value={newName} placeholder="名称,如 anthropic" onChange={setNewName} />
				<TextInput value={newSecret} placeholder="API 密钥(仅入库,不显示)" width={240} onChange={setNewSecret} />
				<button
					className="jide-btn px-3 py-1.5 text-xs"
					disabled={!newName.trim() || !newSecret.trim()}
					onClick={async () => {
						setErr("");
						const r = await s.client?.request("credential.set", { name: newName.trim(), secret: newSecret });
						if (r && !r.ok) setErr(r.error);
						else {
							setNewName("");
							setNewSecret("");
							void refresh();
						}
					}}
				>
					<Icon name="ri-key-2-line" size={13} />
					保存密钥
				</button>
			</div>
			{err && <div className="mt-2 text-xs" style={{ color: "var(--red)" }}>{err}</div>}
		</div>
	);
}

function DevserverPage() {
	const s = useIDE();
	const ds = s.settings?.devserver;
	const [draft, setDraft] = useState<JideSettings["devserver"]>({ ...ds! });
	const [saved, setSaved] = useState(false);
	if (!ds) return null;
	const dirty = JSON.stringify(draft) !== JSON.stringify(ds);
	return (
		<div>
			<SectionTitle>Dev 服务器</SectionTitle>
			<div className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--fg-faint)" }}>
				「运行 → ② 人侧运行 + 预览」的默认参数;下次运行时生效。
			</div>
			<Row label="端口" desc="dev server 监听端口(预览窗口与其同源)">
				<NumInput value={draft.port} min={1024} max={65535} onChange={(v) => setDraft({ ...draft, port: v })} />
			</Row>
			<Row label="探测方式" desc="auto:http 探测 + 就绪日志特征(若填写)">
				<Select
					value={draft.probe}
					options={[
						["auto", "auto(推荐)"],
						["http", "http(请求路径)"],
						["port", "port(端口监听)"],
						["log", "log(日志特征)"],
					]}
					onChange={(v) => setDraft({ ...draft, probe: v as JideSettings["devserver"]["probe"] })}
				/>
			</Row>
			<Row label="就绪日志特征" desc="log 探测匹配的输出片段,如 “ready in”(空 = 不用)">
				<TextInput value={draft.readyPattern} placeholder="ready in" mono width={220} onChange={(v) => setDraft({ ...draft, readyPattern: v })} />
			</Row>
			<Row label="启动命令" desc="留空 = 宿主默认(bunx vite --port 端口)">
				<TextInput value={draft.command} placeholder="bunx vite --port {port}" mono width={300} onChange={(v) => setDraft({ ...draft, command: v })} />
			</Row>
			<div className="mt-4 flex items-center gap-3">
				<button
					className="jide-btn px-3 py-1.5 text-xs"
					disabled={!dirty}
					onClick={async () => {
						await s.saveSettings({ devserver: draft });
						setSaved(true);
						setTimeout(() => setSaved(false), 1500);
					}}
				>
					<Icon name="ri-save-line" size={13} />
					保存
				</button>
				{saved && (
					<span className="flex items-center gap-1 text-xs" style={{ color: "var(--green)" }}>
						<Icon name="ri-checkbox-circle-line" size={13} />
						已保存
					</span>
				)}
			</div>
		</div>
	);
}

function AppearancePage() {
	const s = useIDE();
	const st = s.settings!;
	return (
		<div>
			<SectionTitle>外观</SectionTitle>
			<Row label="主题" desc="跟随系统:自动匹配 Windows 深浅色;切换即时生效">
				<Select
					value={st.theme}
					options={[
						["system", "跟随系统"],
						["light", "浅色"],
						["dark", "深色"],
					]}
					onChange={(v) => void s.saveSettings({ theme: v as JideSettings["theme"] })}
				/>
			</Row>
			<Row label="编辑器字号(px)" desc="代码编辑器与 diff 视图的字号,即时生效">
				<NumInput value={st.editorFontSize} min={11} max={18} step={0.5} onChange={(v) => void s.saveSettings({ editorFontSize: v })} />
			</Row>
			<Row label="终端字号(px)" desc="底部终端面板字号,即时生效">
				<NumInput value={st.terminalFontSize} min={10} max={16} onChange={(v) => void s.saveSettings({ terminalFontSize: v })} />
			</Row>
		</div>
	);
}

function TerminalPage() {
	const s = useIDE();
	const st = s.settings!;
	return (
		<div>
			<SectionTitle>终端</SectionTitle>
			<Row label="默认 shell" desc="新开终端使用;pwsh(PowerShell 7)需自行安装,缺失时回退 cmd">
				<Select
					value={st.terminalShell}
					options={[
						["cmd", "cmd.exe"],
						["powershell", "Windows PowerShell 5"],
						["pwsh", "PowerShell 7(pwsh)"],
					]}
					onChange={(v) => void s.saveSettings({ terminalShell: v as JideSettings["terminalShell"] })}
				/>
			</Row>
		</div>
	);
}

function AboutPage() {
	const s = useIDE();
	return (
		<div>
			<SectionTitle>关于</SectionTitle>
			<Row label="版本" desc="JIDE @jide/desktop 0.1.0">
				<span className="font-mono text-xs" style={{ color: "var(--fg-dim)" }}>0.1.0</span>
			</Row>
			<Row label="宿主" desc="bun 主进程标识(app.hello)">
				<span className="font-mono text-xs" style={{ color: "var(--fg-dim)" }}>{s.hostName || "—"}</span>
			</Row>
			<Row label="协议版本" desc="壳 ↔ 宿主类型化协议(PROTOCOL_VERSION)">
				<span className="font-mono text-xs" style={{ color: "var(--fg-dim)" }}>v{PROTOCOL_VERSION}</span>
			</Row>
			<Row label="运行时目录" desc="信任状态 / 计划 / 设置等持久化数据">
				<span className="font-mono text-xs" style={{ color: "var(--fg-dim)" }}>~/.jide</span>
			</Row>
		</div>
	);
}
