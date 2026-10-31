/**
 * 终端面板(@xterm/xterm 6 + 管道式 shell 后端)
 * terminal.output 事件经 window 事件总线 "jide-event" 分发(store 不缓存输出流,避免每字节渲染)。
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useIDE } from "../store";
import type { HostEvent } from "@jide/contracts";

export function TerminalView() {
	const s = useIDE();
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeIdRef = useRef<string | null>(null);
	const [booted, setBooted] = useState(false);

	// xterm 实例生命周期
	useEffect(() => {
		if (!hostRef.current || termRef.current) return;
		const term = new Terminal({
			fontFamily: '"Cascadia Code","JetBrains Mono",Consolas,monospace',
			fontSize: 12,
			lineHeight: 1.35,
			theme: {
				background: "#0e1015",
				foreground: "#aab3c5",
				cursor: "#6ea8fe",
				selectionBackground: "rgba(110,168,254,.25)",
			},
			convertEol: true,
			scrollback: 5000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(hostRef.current);
		termRef.current = term;
		fitRef.current = fit;
		try {
			fit.fit();
		} catch {}
		term.onData((data) => {
			const id = activeIdRef.current;
			if (id) useIDE.getState().terminalWrite(id, data);
		});
		const onResize = () => {
			try {
				fit.fit();
			} catch {}
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			term.dispose();
			termRef.current = null;
		};
	}, []);

	// 宿主输出 → xterm
	useEffect(() => {
		const handler = (e: Event) => {
			const event = (e as CustomEvent<HostEvent>).detail;
			if (event.type === "terminal.output" && event.terminalId === activeIdRef.current) {
				termRef.current?.write(event.data);
			}
		};
		window.addEventListener("jide-event", handler);
		return () => window.removeEventListener("jide-event", handler);
	}, []);

	// 活动终端切换:重置视图
	useEffect(() => {
		const id = s.activeTerminalId;
		activeIdRef.current = id;
		if (id && !booted) {
			setBooted(true);
			termRef.current?.writeln("\x1b[90m— JIDE 终端(管道式 shell;PTY 待运行时修复)—\x1b[0m");
		}
	}, [s.activeTerminalId]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 px-3 py-1" style={{ borderBottom: "1px solid var(--line)" }}>
				{s.terminals.map((t) => (
					<button
						key={t.id}
						className="rounded px-2 py-0.5 text-[11px]"
						style={{
							background: t.id === s.activeTerminalId ? "var(--bg3)" : undefined,
							color: t.id === s.activeTerminalId ? "var(--fg)" : "var(--fg-faint)",
						}}
						onClick={() => useIDE.setState({ activeTerminalId: t.id })}
					>
						{t.id.replace("term-", "终端 ")}
					</button>
				))}
				<button
					className="rounded px-1.5 text-xs hover:bg-[var(--bg3)]"
					style={{ color: "var(--fg-dim)" }}
					title="新建终端(随工作区)"
					onClick={() => void s.createTerminal()}
				>
					+
				</button>
				<button
					className="ml-auto rounded border px-1.5 py-0.5 text-[10.5px]"
					style={{ borderColor: "#4a6db3", background: "var(--acc-dim)", color: "#dbe7ff" }}
					title="把终端最近输出送去对话"
					onClick={() => {
						const id = s.activeTerminalId;
						if (!id) return;
						const buf = s.terminalBuffers[id] ?? [];
						const text = buf.join("").replace(/[[0-9;]*[A-Za-z]/g, "").slice(-400);
						void s.askAgent("terminal", text || "(终端无输出)", "终端这段输出是什么情况?");
					}}
				>
					✦ 问 agent
				</button>
			</div>
			<div ref={hostRef} className="min-h-0 flex-1 px-1 py-0.5" />
		</div>
	);
}
