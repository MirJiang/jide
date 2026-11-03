/**
 * TerminalManager — 工作区分组终端(M2 基面;DR-TS-05 起 ConPTY 优先)
 *
 * 实现说明(风险决策的两段历史):
 *  - spike#2( cottontail 时代):node-pty(ConPTY)在 Bun/cottontail 运行时下 socket
 *    立即关闭(node-pty@1.1.0 与 @lydell/node-pty 同症状),故 M2 采用管道式 shell;
 *  - DR-TS-05(Electron 时代):daemon 迁至 Electron/Node 运行时,ConPTY 实测可用
 *    (Electron 45.2.1 + node-pty@1.1.0,echo 往返验证),PTY 成为首选路径。
 * 运行时探测:Bun 下仍走管道(bun test 兼容);Node 下加载 node-pty 失败也回退管道。
 * 两路径接口一致:write/resize/dispose + terminal.output/exit 事件。
 */

import { createRequire } from "node:module";
import type { EmitFn } from "./agent-host";
import { spawn, type RtSubprocess } from "../../runtime";

/* ---------------- node-pty 动态加载(daemon bundle 对其保持 external) ---------------- */

interface PtyProcess {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(cb: (data: string) => void): void;
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
interface PtyModule {
	spawn(
		file: string,
		args: string[],
		opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string | undefined> },
	): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
	if (ptyModule !== undefined) return ptyModule;
	// Bun 下 ConPTY socket 即断(spike#2 实测),强制管道
	if (process.versions.bun) {
		ptyModule = null;
		return ptyModule;
	}
	try {
		// 以 daemon bundle 所在位置为基解析 node_modules(打包态随 extraResources 落资源目录)
		const req = createRequire(import.meta.url);
		ptyModule = req("node-pty") as unknown as PtyModule;
	} catch {
		ptyModule = null;
	}
	return ptyModule;
}

export interface TerminalEntry {
	id: string;
	workspaceId: string;
	/** 管道回退路径的子进程(PTY 路径为 null) */
	proc: RtSubprocess | null;
	/** PTY(ConPTY)路径 */
	pty: PtyProcess | null;
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
		const shell = this.resolveShell();
		const shellCwd = cwd ?? process.cwd();
		const entry: TerminalEntry = {
			id,
			workspaceId,
			proc: null,
			pty: null,
			writer: null,
			nextId: 0,
			buf: [],
			pending: "",
		};

		/* ---------- PTY(ConPTY)首选路径 ---------- */
		const ptyMod = loadPty();
		if (ptyMod) {
			try {
				const p = ptyMod.spawn(shell, [], {
					name: "xterm-256color",
					cols: 120,
					rows: 30,
					cwd: shellCwd,
					env: { ...process.env, TERM: "xterm-256color", PROMPT: "$P$G" } as Record<string, string | undefined>,
				});
				entry.pty = p;
				this.terminals.set(id, entry);
				p.onData((data) => {
					// 输出原样透传 xterm(PTY 自带 TTY 语义);环形缓冲仍剥 ANSI 供模型读
					this.emit({ type: "terminal.output", terminalId: id, data });
					this.appendChunk(entry, data);
				});
				p.onExit((e) => {
					this.emit({ type: "terminal.exit", terminalId: id, code: e.exitCode ?? 0 });
					this.terminals.delete(id);
				});
				return entry;
			} catch {
				// ConPTY 拉起失败(壳缺失等)→ 回退管道
				entry.pty = null;
			}
		}

		/* ---------- 管道回退路径(bun test / 无 node-pty)---------- */
		const spawnOpts = {
			cwd: shellCwd,
			stdin: "pipe" as const,
			stdout: "pipe" as const,
			stderr: "pipe" as const,
			env: {
				...process.env,
				TERM: "xterm-256color",
				PROMPT: "$P$G",
			},
		};
		try {
			entry.proc = spawn([shell], spawnOpts);
		} catch {
			entry.proc = spawn([process.env.COMSPEC ?? "cmd.exe"], spawnOpts);
		}
		this.terminals.set(id, entry);

		const pump = async (stream: ReadableStream<Uint8Array>, isErr: boolean) => {
			const decoder = new TextDecoderStream();
			const text = stream.pipeThrough(decoder as unknown as ReadableWritablePair<string, Uint8Array>);
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
		pump(entry.proc.stdout as ReadableStream<Uint8Array>, false);
		pump(entry.proc.stderr as ReadableStream<Uint8Array>, true);

		void entry.proc.exited.then((code) => {
			this.emit({ type: "terminal.exit", terminalId: id, code });
			this.terminals.delete(id);
		});

		return entry;
	}

	write(id: string, data: string) {
		const entry = this.terminals.get(id);
		if (!entry) return { ok: false as const, error: "终端不存在" };
		if (entry.pty) {
			entry.pty.write(data);
			return { ok: true as const };
		}
		// runtime.spawn 的 stdin(pipe)是 RtStdin:write + flush(flush 为兼容 no-op)
		const sink = entry.proc?.stdin;
		if (!sink) return { ok: false as const, error: "stdin 不可写" };
		sink.write(data);
		sink.flush();
		return { ok: true as const };
	}

	/** PTY 路径 resize 生效;管道式 shell 无真实 TTY 尺寸(仍回 ok 保持契约) */
	resize(id: string, cols: number, rows: number) {
		const entry = this.terminals.get(id);
		if (!entry) return { ok: false as const, error: "终端不存在" };
		entry.pty?.resize(cols, rows);
		return { ok: true as const };
	}

	dispose(id: string) {
		const entry = this.terminals.get(id);
		if (!entry) return { ok: false as const, error: "终端不存在" };
		// Windows 进程树回收:shell 可能派生子进程(cmd → bun 等),taskkill /T 兜底
		const pid = entry.pty?.pid ?? entry.proc?.pid;
		entry.pty?.kill();
		entry.proc?.kill();
		if (process.platform === "win32" && pid) {
			spawn(["taskkill", "/F", "/T", "/PID", String(pid)], {
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
