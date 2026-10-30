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
}

let nextTerminal = 1;

export class TerminalManager {
	private terminals = new Map<string, TerminalEntry>();
	private emit: EmitFn = () => {};

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	listByWorkspace(workspaceId: string) {
		return [...this.terminals.values()].filter((t) => t.workspaceId === workspaceId);
	}

	create(workspaceId: string, cwd?: string): TerminalEntry {
		const id = `term-${nextTerminal++}`;
		// shell 选择:优先 powershell(错误着色更好),回退 cmd
		const shell = process.env.COMSPEC ?? "cmd.exe";
		const proc = Bun.spawn([shell], {
			cwd: cwd ?? process.cwd(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				TERM: "xterm-256color",
				PROMPT: "$P$G",
			},
		});
		const entry: TerminalEntry = {
			id,
			workspaceId,
			proc,
			writer: null,
			nextId: 0,
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
		entry.proc.kill();
		this.terminals.delete(id);
		return { ok: true as const };
	}

	disposeAll() {
		for (const id of [...this.terminals.keys()]) this.dispose(id);
	}
}
