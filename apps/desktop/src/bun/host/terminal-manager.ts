/**
 * TerminalManager — 工作区分组终端(M2 基面)
 *
 * 实现说明(风险决策):node-pty(ConPTY)在 Bun/cottontail 运行时下 socket 立即关闭
 * (实测 node-pty@1.1.0 与 @lydell/node-pty 两类包同症状,spike#2 记录),故 M2 采用
 * 管道式 shell:Bun.spawn 的 stdin/stdout/stderr 管道 + 前端 xterm 渲染。
 * 命令执行、输出流、错误行识别、压测均不受影响;交互式 TUI(方向键/全屏程序)降级,
 * 待运行时修复 ConPTY 后替换为 PTY 实现(接口不变:write/resize/dispose)。
 */

import type { EmitFn } from "./agent-host";

export interface TerminalEntry {
	id: string;
	workspaceId: string;
	proc: Process;
	writer: WritableStreamDefaultWriter<Uint8Array> | null;
	nextId: number;
	/** 输出环形缓冲(剥 ANSI 后的完整行,尾部 500 行;供 terminal_read 工具读屏) */
	buf: string[];
	/** 未凑满一行的剩余片段 */
	pending: string;
}

let nextTerminal = 1;

const MAX_TERM_BUF_LINES = 500;

/** 剥 ANSI 转义(CSI/OSC)与回车,便于模型阅读 */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "").replace(/\r/g, "");

export class TerminalManager {
	private terminals = new Map<string, TerminalEntry>();
	private emit: EmitFn = () => {};
	/** 设置驱动的 shell 选择("cmd" | "powershell" | "pwsh");找不到可执行时回退 cmd */
	private getShell: () => "cmd" | "powershell" | "pwsh" = () => "cmd";

	constructor(getShell?: () => "cmd" | "powershell" | "pwsh") {
		if (getShell) this.getShell = getShell;
	}

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	listByWorkspace(workspaceId: string) {
		return [...this.terminals.values()].filter((t) => t.workspaceId === workspaceId);
	}

	/** 工作区最新一个终端(Map 保持插入序;无则 null) */
	latestForWorkspace(workspaceId: string): TerminalEntry | null {
		const list = this.listByWorkspace(workspaceId);
		return list.length ? list[list.length - 1] : null;
	}

	/** 尾部读取(terminal_read 工具;ANSI 已剥离;最后一行可能未收尾) */
	tail(id: string, lines = 40): { ok: true; lines: string[] } | { ok: false; error: string } {
		const e = this.terminals.get(id);
		if (!e) return { ok: false as const, error: "终端不存在或已退出" };
		const n = Math.max(1, Math.min(lines, MAX_TERM_BUF_LINES));
		const out = e.buf.slice(-n);
		if (e.pending.trim()) out.push(`${e.pending} …(未收尾)`);
		return { ok: true as const, lines: out };
	}

	private appendChunk(entry: TerminalEntry, chunk: string) {
		entry.pending += chunk;
		let idx: number;
		while ((idx = entry.pending.indexOf("\n")) >= 0) {
			const line = stripAnsi(entry.pending.slice(0, idx));
			entry.pending = entry.pending.slice(idx + 1);
			if (line.trim()) {
				entry.buf.push(line);
				if (entry.buf.length > MAX_TERM_BUF_LINES) entry.buf.splice(0, entry.buf.length - MAX_TERM_BUF_LINES);
			}
		}
	}

	private resolveShell(): string {
		switch (this.getShell()) {
			case "powershell":
				return "powershell.exe";
			case "pwsh":
				return "pwsh.exe";
			default:
				return process.env.COMSPEC ?? "cmd.exe";
		}
	}

	create(workspaceId: string, cwd?: string): TerminalEntry {
		const id = `term-${nextTerminal++}`;
		// shell 由设置决定(pwsh 未装等 spawn 失败时回退 cmd)
		const spawnOpts = {
			cwd: cwd ?? process.cwd(),
			stdin: "pipe" as const,
			stdout: "pipe" as const,
			stderr: "pipe" as const,
			env: {
				...process.env,
				TERM: "xterm-256color",
				PROMPT: "$P$G",
			},
		};
		let proc: Process;
		try {
			proc = Bun.spawn([this.resolveShell()], spawnOpts);
		} catch {
			proc = Bun.spawn([process.env.COMSPEC ?? "cmd.exe"], spawnOpts);
		}
		const entry: TerminalEntry = {
			id,
			workspaceId,
			proc,
			writer: null,
			nextId: 0,
			buf: [],
			pending: "",
		};
		this.terminals.set(id, entry);

		const pump = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
			const decoder = new TextDecoderStream();
			const text = stream.pipeThrough(decoder);
			const reader = text.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					// 输出转 xterm 转义序列:err 行染红由前端按行缓冲判断,这里原样透传
					this.emit({ type: "terminal.output", terminalId: id, data: value });
					this.appendChunk(entry, value);
					if (isErr) {
						this.emit({
							type: "host.log",
							level: "warn",
							message: `[term ${id}] ${value.slice(0, 300)}`,
						});
					}
				}
			} catch {
				/* 流关闭 */
			}
		};
		pump(proc.stdout as ReadableStream<Uint8Array>, false);
		pump(proc.stderr as ReadableStream<Uint8Array>, true);

		void proc.exited.then((code) => {
			this.emit({ type: "terminal.exit", terminalId: id, code });
			this.terminals.delete(id);
		});

		return entry;
	}

	write(id: string, data: string) {
		const entry = this.terminals.get(id);
		if (!entry) return { ok: false as const, error: "终端不存在" };
		// Bun.spawn 的 stdin(pipe)是 FileSink:write + flush
		const sink = entry.proc.stdin as unknown as { write: (s: string) => number; flush: () => void } | number;
		if (typeof sink === "number") return { ok: false as const, error: "stdin 不可写" };
		sink.write(data);
		sink.flush();
		return { ok: true as const };
	}

	/** 管道式 shell 无真实 TTY 尺寸;记录以备 PTY 升级,当前为 no-op */
	resize(id: string, _cols: number, _rows: number) {
		if (!this.terminals.has(id)) return { ok: false as const, error: "终端不存在" };
		return { ok: true as const };
	}

	dispose(id: string) {
		const entry = this.terminals.get(id);
		if (!entry) return { ok: false as const, error: "终端不存在" };
		// Windows 进程树回收:shell 可能派生子进程(cmd → bun 等),taskkill /T 兜底
		entry.proc.kill();
		if (process.platform === "win32" && entry.proc.pid) {
			Bun.spawn(["taskkill", "/F", "/T", "/PID", String(entry.proc.pid)], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}
		this.terminals.delete(id);
		return { ok: true as const };
	}

	disposeAll() {
		for (const id of [...this.terminals.keys()]) this.dispose(id);
	}
}
