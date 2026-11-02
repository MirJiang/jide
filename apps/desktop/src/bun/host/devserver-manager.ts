/**
 * DevServerManager — 测试域 4A(business-design §4A)
 *
 *  - 工作区持有 dev server 生命周期:ensure(启动+就绪等待)/ stop / status
 *  - 就绪探测三模式:http 轮询(GET / 等 2xx)/ port 连通 / log 特征;
 *    auto:先 log 特征(若给了 readyPattern),并行 http,谁先命中谁算
 *  - 崩溃感知:进程退出 → crashed 事件;端口失联 → 下次 status 时发现
 *  - agent 与内嵌预览共享同一实例(共引擎原则)
 */

import type { EmitFn } from "./agent-host";
import { spawn, tcpConnect, type RtSubprocess } from "../../runtime";

export interface DevServerOptions {
	command: string;
	cwd: string;
	port: number;
	probe: "auto" | "http" | "port" | "log";
	readyPattern?: string;
}

interface DevServerEntry {
	workspaceId: string;
	proc: RtSubprocess | null;
	opts: DevServerOptions;
	state: "stopped" | "starting" | "ready" | "crashed";
	url: string | null;
	probeMode: string;
	logTail: string[];
	startedAt: number;
}

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 400;

export class DevServerManager {
	private servers = new Map<string, DevServerEntry>();
	private emit: EmitFn = () => {};
	/** 逐行日志回调(日志回喂泵订阅;appendLog 同步上下文,回调须快、勿阻塞) */
	onLogLine: ((workspaceId: string, line: string) => void) | null = null;

	bindEmitter(emit: EmitFn) {
		this.emit = emit;
	}

	private pushStatus(entry: DevServerEntry) {
		this.emit({
			type: "devserver.status",
			workspaceId: entry.workspaceId,
			state: entry.state,
			url: entry.url,
			probeMode: entry.probeMode,
		});
	}

	status(workspaceId: string) {
		const entry = this.servers.get(workspaceId);
		if (!entry) {
			return { ok: true as const, state: "stopped" as const, url: null, probeMode: "auto" };
		}
		return { ok: true as const, state: entry.state, url: entry.url, probeMode: entry.probeMode };
	}

	private appendLog(entry: DevServerEntry, chunk: string) {
		for (const line of chunk.split(/\r?\n/)) {
			if (line.trim()) {
				entry.logTail.push(line);
				try {
					this.onLogLine?.(entry.workspaceId, line);
				} catch {
					// 回调异常不影响日志收集
				}
			}
		}
		if (entry.logTail.length > 200) entry.logTail.splice(0, entry.logTail.length - 200);
	}

	/** 启动(若已就绪直接返回;若 crashed 先清理再重启) */
	async ensure(workspaceId: string, opts: DevServerOptions): Promise<
		{ ok: true; url: string; port: number; probeMode: string; startedMs: number } | { ok: false; error: string; logTail?: string }
	> {
		const existing = this.servers.get(workspaceId);
		if (existing?.state === "ready") {
			return {
				ok: true,
				url: existing.url!,
				port: existing.opts.port,
				probeMode: existing.probeMode,
				startedMs: 0,
			};
		}
		if (existing?.proc) {
			existing.proc.kill();
			this.servers.delete(workspaceId);
		}

		const entry: DevServerEntry = {
			workspaceId,
			proc: null,
			opts,
			state: "starting",
			url: null,
			probeMode: opts.probe === "auto" ? (opts.readyPattern ? "log+http" : "http") : opts.probe,
			logTail: [],
			startedAt: Date.now(),
		};
		this.servers.set(workspaceId, entry);
		this.pushStatus(entry);

		try {
			// command 形如 "bunx vite --port 5199" → 拆 argv(shlex 简版:按空格,支持引号)
			const argv = opts.command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/"/g, "")) ?? [];
			const proc = spawn(argv, {
				cwd: opts.cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, FORCE_COLOR: "0" },
			});
			entry.proc = proc;

			this.pumpLogs(entry, proc.stdout as ReadableStream<Uint8Array>);
			this.pumpLogs(entry, proc.stderr as ReadableStream<Uint8Array>);

			void proc.exited.then((code) => {
				if (this.servers.get(workspaceId) === entry && entry.state !== "stopped") {
					entry.state = "crashed";
					this.pushStatus(entry);
					this.emit({
						type: "host.log",
						level: "warn",
						message: `dev server 退出(code=${code}),状态=crashed,agent 可重启`,
					});
				}
			});
		} catch (err: any) {
			entry.state = "crashed";
			this.pushStatus(entry);
			return { ok: false, error: `启动失败:${err?.message ?? err}`, logTail: entry.logTail.slice(-10).join("\n") };
		}

		const ok = await this.waitReady(entry);
		if (!ok) {
			return {
				ok: false,
				error: `就绪探测超时(${READY_TIMEOUT_MS}ms,模式=${entry.probeMode})`,
				logTail: entry.logTail.slice(-15).join("\n"),
			};
		}
		entry.state = "ready";
		entry.url = `http://localhost:${opts.port}`;
		this.pushStatus(entry);
		return {
			ok: true,
			url: entry.url,
			port: opts.port,
			probeMode: entry.probeMode,
			startedMs: Date.now() - entry.startedAt,
		};
	}

	private pumpLogs(entry: DevServerEntry, stream: ReadableStream<Uint8Array>) {
		void (async () => {
			const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					this.appendLog(entry, value);
				}
			} catch {
				/* closed */
			}
		})();
	}

	/** 三模式探测:auto = log 特征 + http 轮询并行(谁先命中);http/port 单独 */
	private async waitReady(entry: DevServerEntry): Promise<boolean> {
		const mode = entry.opts.probe;
		const deadline = Date.now() + READY_TIMEOUT_MS;

		const httpOk = async (): Promise<boolean> => {
			try {
				const res = await fetch(`http://127.0.0.1:${entry.opts.port}/`, {
					signal: AbortSignal.timeout(1500),
				});
				return res.status >= 200 && res.status < 400;
			} catch {
				return false;
			}
		};
		const portOk = async (): Promise<boolean> => {
			try {
				const socket = await tcpConnect({
					hostname: "127.0.0.1",
					port: entry.opts.port,
					socket: {
						data() {},
						close() {},
						error() {},
					},
				});
				socket.end();
				return true;
			} catch {
				return false;
			}
		};
		const logOk = (): boolean =>
			entry.opts.readyPattern ? entry.logTail.some((l) => l.includes(entry.opts.readyPattern!)) : false;

		const probeFn =
			mode === "http" ? httpOk : mode === "port" ? portOk : mode === "log" ? async () => logOk() : httpOk;

		while (Date.now() < deadline) {
			// 崩溃快速失败:进程已退出且从未就绪 → 立即判失败(避免等满超时)
			if (entry.proc && entry.proc.exitCode !== null) {
				// 给日志泵一小段时间收尾,再判死
				await new Promise((r) => setTimeout(r, 600));
				if (mode === "auto" && (logOk() || (await httpOk()))) return true;
				if (mode !== "auto" && (await probeFn())) return true;
				return false;
			}
			if (mode === "auto") {
				if (logOk() || (await httpOk())) return true;
			} else if (await probeFn()) {
				return true;
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		return false;
	}

	async stop(workspaceId: string) {
		const entry = this.servers.get(workspaceId);
		if (!entry) return { ok: false as const, error: "无运行中的 dev server" };
		entry.state = "stopped";
		entry.proc?.kill();
		// Windows 进程树回收(dev server 派生 vite/esbuild 等)
		if (process.platform === "win32" && entry.proc?.pid) {
			spawn(["taskkill", "/F", "/T", "/PID", String(entry.proc.pid)], { stdout: "ignore", stderr: "ignore" });
		}
		this.servers.delete(workspaceId);
		this.pushStatus({ ...entry, url: null });
		return { ok: true as const };
	}

	stopAll() {
		for (const id of [...this.servers.keys()]) void this.stop(id);
	}

	/** 终端/日志尾(错误上下文用) */
	logTail(workspaceId: string, lines = 20): string[] {
		return this.servers.get(workspaceId)?.logTail.slice(-lines) ?? [];
	}
}
