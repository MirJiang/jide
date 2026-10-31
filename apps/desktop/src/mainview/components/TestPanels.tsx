/** 底部面板:测试(4D 选测+失败详情+问 agent)与检查项(4E) */

import { useEffect, useState } from "react";
import { useIDE } from "../store";

interface TestResultView {
	name: string;
	file: string;
	status: "pass" | "fail" | "skip";
	durationMs: number;
	message?: string;
}

export function TestPanel() {
	const s = useIDE();
	const [results, setResults] = useState<TestResultView[]>([]);
	const [meta, setMeta] = useState<{ selected: number; total: number; ms: number } | null>(null);
	const [running, setRunning] = useState(false);
	const [autoUpgraded, setAutoUpgraded] = useState(false);
	const [scope, setScope] = useState<"diff" | "all">("diff");

	const run = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		setRunning(true);
		setResults([]);
		const r = await s.client.request("test.run", { workspaceId: s.activeWorkspaceId, scope });
		setRunning(false);
		if (r.ok) {
			setResults(r.results as TestResultView[]);
			setMeta({ selected: r.selected, total: r.total, ms: r.durationMs });
			// §4D:子集失败 → 自动升级全量回归
			const failed = r.results.some((x) => x.status === "fail");
			if (failed && scope === "diff") {
				setScope("all");
				const full = await s.client!.request("test.run", { workspaceId: s.activeWorkspaceId!, scope: "all" });
				if (full.ok) {
					setResults(full.results as TestResultView[]);
					setMeta({ selected: full.selected, total: full.total, ms: full.durationMs });
					setAutoUpgraded(true);
				}
			} else {
				setAutoUpgraded(false);
			}
		}
	};

	const pass = results.filter((r) => r.status === "pass").length;
	const fail = results.filter((r) => r.status === "fail").length;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-3.5 py-1.5 text-xs" style={{ borderBottom: "1px solid var(--line)", color: "var(--fg-dim)" }}>
				<span className="flex items-center gap-1.5 rounded px-2 py-0.5" style={{ background: "var(--purple-bg)", color: "var(--purple)" }}>
					⚡ 智能选测:diff 文件集 → 关联用例
				</span>
				<select
					value={scope}
					onChange={(e) => setScope(e.target.value as "diff" | "all")}
					className="rounded border bg-transparent px-1 py-0.5"
					style={{ borderColor: "var(--line)", color: "var(--fg-dim)" }}
				>
					<option value="diff">选测(diff)</option>
					<option value="all">全量</option>
				</select>
				<button
					onClick={() => void run()}
					disabled={running || !s.activeWorkspaceId}
					className="rounded border px-2.5 py-0.5 disabled:opacity-40"
					style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
				>
					{running ? "运行中…" : "运行"}
				</button>
				{meta && (
					<span className="font-mono text-[11px]">
						选测 {meta.selected}/{meta.total} · {meta.ms}ms ·{" "}
						<span style={{ color: "var(--green)" }}>通过 {pass}</span> ·{" "}
						<span style={{ color: fail ? "var(--red)" : "var(--fg-faint)" }}>失败 {fail}</span>
					</span>
				)}
			</div>
			<div className="flex-1 overflow-y-auto font-mono text-[12px]">
				{results.map((r, i) => (
					<div key={i}>
						<div
							className="flex items-center gap-2 px-3.5 py-1"
							style={{ borderBottom: "1px solid rgba(38,43,58,.5)", color: r.status === "fail" ? "#e8a9a9" : "var(--fg-dim)" }}
						>
							<span style={{ color: r.status === "pass" ? "var(--green)" : r.status === "fail" ? "var(--red)" : "var(--fg-faint)" }}>
								{r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "–"}
							</span>
							<span className="truncate">{r.name}</span>
							<span className="ml-auto text-[10.5px]" style={{ color: "var(--fg-faint)" }}>
								{r.durationMs}ms · {r.file}
							</span>
						</div>
						{r.status === "fail" && r.message && (
							<div className="mx-3.5 mb-2 rounded border px-2.5 py-1.5 text-[11.5px] leading-relaxed" style={{ background: "var(--red-bg)", borderColor: "rgba(248,113,113,.25)", color: "#e8bdb8" }}>
								<pre className="max-h-24 overflow-auto whitespace-pre-wrap">{r.message}</pre>
								<button
									className="mt-1 rounded border px-2 py-0.5 text-[11px]"
									style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
									onClick={() => void s.askAgent("test", `${r.file} · ${r.name} 失败:${r.message?.slice(0, 300)}`, "这个失败为什么发生?")}
								>
									✦ 问 agent:这次失败为什么?
								</button>
							</div>
						)}
					</div>
				))}
				{!results.length && !running && (
					<div className="px-3.5 py-2 text-[11.5px]" style={{ color: "var(--fg-faint)" }}>
						运行智能选测:变更文件自动映射关联用例子集(12/48 级别);子集失败时切「全量」回归。
					</div>
				)}
			</div>
		</div>
	);
}

interface CheckView {
	id: string;
	title: string;
	kind: "asset" | "temp";
	assertion: { type: string; url?: string };
	lastResult?: { passed: boolean; at: string; evidence?: string };
}

export function ChecksPanel() {
	const s = useIDE();
	const [checks, setChecks] = useState<CheckView[]>([]);
	const [running, setRunning] = useState(false);
	const [lastRun, setLastRun] = useState<Array<{ id: string; passed: boolean; detail?: string }> | null>(null);

	const refresh = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		const r = await s.client.request("checks.list", { workspaceId: s.activeWorkspaceId });
		if (r.ok) setChecks(r.checks as CheckView[]);
	};

	useEffect(() => {
		void refresh();
	}, [s.activeWorkspaceId]);

	const run = async () => {
		if (!s.client || !s.activeWorkspaceId) return;
		setRunning(true);
		const r = await s.client.request("checks.run", { workspaceId: s.activeWorkspaceId });
		setRunning(false);
		if (r.ok) {
			setLastRun(r.results.map((x) => ({ id: x.id, passed: x.passed, detail: x.detail })));
			void refresh();
		}
	};

	const resultOf = (id: string) => lastRun?.find((x) => x.id === id);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-3.5 py-1.5 text-xs" style={{ borderBottom: "1px solid var(--line)", color: "var(--fg-dim)" }}>
				<button
					onClick={() => void run()}
					disabled={running || !s.activeWorkspaceId}
					className="rounded border px-2.5 py-0.5 disabled:opacity-40"
					style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
				>
					{running ? "复验中…" : "一键复验"}
				</button>
				<span className="text-[11px]" style={{ color: "var(--fg-faint)" }}>
					资产存 .jide/checks/(diff 命中自动带上);临时项仅本次
				</span>
				<span className="ml-auto font-mono text-[11px]">{checks.length} 项</span>
			</div>
			<div className="flex-1 overflow-y-auto">
				{checks.map((c) => {
					const res = resultOf(c.id) ?? (c.lastResult ? { passed: c.lastResult.passed, detail: "" } : null);
					return (
						<div key={c.id} className="flex items-center gap-2.5 px-3.5 py-1.5 text-xs" style={{ borderBottom: "1px solid rgba(38,43,58,.5)" }}>
							<span
								className="inline-block h-[15px] w-[15px] flex-none rounded border text-center text-[10px] leading-[14px]"
								style={{
									borderColor: res ? (res.passed ? "var(--green)" : "var(--red)") : "var(--fg-faint)",
									background: res?.passed ? "var(--green-bg)" : undefined,
									color: "var(--green)",
								}}
							>
								{res?.passed ? "✓" : res && !res.passed ? "✗" : ""}
							</span>
							<span className="truncate" style={{ color: res ? "var(--fg)" : "var(--fg-dim)" }}>{c.title}</span>
							<span className="font-mono text-[10px]" style={{ color: "var(--fg-faint)" }}>{c.assertion.type}</span>
							<span
								className="ml-auto rounded px-1.5 text-[10px]"
								style={
									c.kind === "asset"
										? { background: "var(--purple-bg)", color: "var(--purple)" }
										: { background: "var(--bg3)", color: "var(--fg-faint)" }
								}
							>
								{c.kind === "asset" ? "项目资产" : "临时"}
							</span>
						</div>
					);
				})}
				{!checks.length && (
					<div className="px-3.5 py-2 text-[11.5px]" style={{ color: "var(--fg-faint)" }}>
						暂无检查项。agent 完成任务后可沉淀(验收断言),或手动创建。
					</div>
				)}
			</div>
		</div>
	);
}
