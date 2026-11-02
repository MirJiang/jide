/**
 * runtime — Node 运行时适配层(DR-TS-05)
 *
 * 目标:daemon/host 不再直接依赖 Bun API,同一份源码可运行于
 *   - Node ≥ 20(含 Electron 主进程经 ELECTRON_RUN_AS_NODE 拉起的 daemon,生产形态);
 *   - Bun(bun test / 源码态直跑,开发形态)。
 *
 * 只覆盖既有调用面(diem:spawn 管道采集 / FileSink 写 / serve+ws upgrade / TCP 探活),
 * 不追求完整 Bun 兼容。形状刻意与 Bun 对齐:
 *   - RtSubprocess.exited: Promise<number>(Bun.Subprocess.exited 同形);
 *   - stdout/stderr 为 Web ReadableStream —— 既有代码的 `new Response(p.stdout).text()`
 *     与 `getReader()` 泵无需改动;
 *   - stdin 提供 write+flush(FileSink 同形,flush 为 no-op,Node 即写即通)。
 *   - serve():镜像 Bun.serve 的 fetch(req, srv)+ srv.upgrade + websocket{open,close,message}
 *     模型(node:http + ws)。
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess } from "node:child_process";
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from "ws";

/* ---------------- 子进程 ---------------- */

export interface RtStdin {
	write(data: string | Uint8Array): number;
	/** FileSink 形状兼容:Node 写入即通,无需真实 flush */
	flush(): void;
	end(): void;
}

export interface RtSubprocess {
	pid: number;
	stdin: RtStdin | null;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	/** null = 运行中(node 语义;Bun.Subprocess 同名字段同义) */
	exitCode: number | null;
	exited: Promise<number>;
	kill(): void;
}

export interface RtSpawnOpts {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: "pipe" | "ignore";
	stdout?: "pipe" | "ignore";
	stderr?: "pipe" | "ignore";
}

export function spawn(cmd: string[], opts: RtSpawnOpts = {}): RtSubprocess {
	const child = nodeSpawn(cmd[0], cmd.slice(1), {
		cwd: opts.cwd,
		env: opts.env,
		stdio: [
			opts.stdin === "pipe" ? "pipe" : "ignore",
			opts.stdout === "ignore" ? "ignore" : "pipe",
			opts.stderr === "ignore" ? "ignore" : "pipe",
		],
		// 不进父进程组:daemon 派生的 dev server / shell 需要独立进程树(taskkill /T 兜底)
		windowsHide: true,
	});

	const toWeb = (s: Readable | null): ReadableStream<Uint8Array> =>
		s ? (Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>) : new ReadableStream({ start: (c) => c.close() });

	const stdin: RtStdin | null = child.stdin
		? {
				write: (data) => (child.stdin!.write(data as never), 0),
				flush: () => {},
				end: () => child.stdin!.end(),
			}
		: null;

	const exited = new Promise<number>((resolve) => {
		child.on("close", (code) => resolve(code ?? -1));
	});

	return {
		get pid() {
			return child.pid ?? -1;
		},
		stdin,
		stdout: toWeb(child.stdout),
		stderr: toWeb(child.stderr),
		get exitCode() {
			return child.exitCode;
		},
		exited,
		kill: () => child.kill(),
	};
}

export function spawnSync(cmd: string[]): { status: number | null; stdout: Buffer; stderr: Buffer } {
	const r = nodeSpawnSync(cmd[0], cmd.slice(1), { windowsHide: true });
	return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function write(path: string, data: string | Uint8Array): Promise<void> {
	await fsWriteFile(path, data);
}

/** TCP 探活(Bun.connect 的端口探测用法):连通 resolve,拒绝/超时由调用方 catch */
export function tcpConnect(opts: { hostname: string; port: number }): Promise<{ end(): void }> {
	return new Promise((resolve, reject) => {
		const s = createConnection({ host: opts.hostname, port: opts.port });
		s.once("connect", () => resolve({ end: () => s.end() }));
		s.once("error", (err) => {
			s.destroy();
			reject(err);
		});
	});
}

/* ---------------- HTTP + WebSocket 服务(Bun.serve 同形子集) ---------------- */

export interface RtWs extends RtServerWebSocket {
	data?: unknown;
}
export interface RtServerWebSocket {
	send(data: string): void;
	close(): void;
}

export interface RtServeOpts {
	hostname?: string;
	port?: number;
	fetch(
		req: Request,
		srv: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
	): Response | Promise<Response>;
	websocket?: {
		open?(ws: RtWs): void;
		close?(ws: RtServerWebSocket): void;
		message?(ws: RtServerWebSocket, msg: string): void;
	};
}

export interface RtServe {
	port: number;
	stop(closeActiveConnections?: boolean): void;
}

function requestFromIncoming(req: IncomingMessage): Promise<Request> {
	return new Promise((resolve, reject) => {
		const host = req.headers.host ?? "127.0.0.1";
		const url = `http://${host}${req.url ?? "/"}`;
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v === undefined) continue;
			headers.set(k, Array.isArray(v) ? v.join(", ") : v);
		}
		if (req.method === "GET" || req.method === "HEAD") {
			resolve(new Request(url, { method: req.method, headers }));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			resolve(new Request(url, { method: req.method, headers, body: body.length ? body : undefined }));
		});
		req.on("error", reject);
	});
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => {
		headers[k] = v;
	});
	res.writeHead(response.status, headers);
	if (response.body) {
		Readable.fromWeb(response.body as never).pipe(res);
	} else {
		res.end();
	}
}

export function serve(opts: RtServeOpts): Promise<RtServe> {
	return new Promise((resolveServe) => {
		resolveServeServe(opts, resolveServe);
	});
}

function resolveServeServe(opts: RtServeOpts, resolveServe: (srv: RtServe) => void): void {
	const noUpgradeSrv = { upgrade: (): boolean => false };
	const httpServer = httpCreateServer((req, res) => {
		void (async () => {
			const request = await requestFromIncoming(req);
			const response = await opts.fetch(request, noUpgradeSrv);
			await writeResponse(res, response);
		})().catch((err) => {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain" });
			}
			res.end(`internal error: ${String(err?.message ?? err)}`);
		});
	});

	const liveSockets = new Set<ServerResponse | import("node:net").Socket>();
	httpServer.on("connection", (socket) => {
		liveSockets.add(socket);
		socket.on("close", () => liveSockets.delete(socket));
	});

	let wss: WebSocketServer | null = null;
	if (opts.websocket) {
		wss = new WebSocketServer({ noServer: true });
		const handlers = opts.websocket;
		// upgrade 请求走独立事件:在 fetch 内同步决定是否握手(镜像 Bun 的 srv.upgrade 语义)
		httpServer.on("upgrade", (req, socket, head) => {
			void (async () => {
				const request = await requestFromIncoming(req);
				let handled = false;
				const srv = {
					upgrade: (_req: Request, upgradeOpts?: { data?: unknown }): boolean => {
						if (handled) return false;
						handled = true;
						wss!.handleUpgrade(req, socket, head, (ws) => {
							const rt = ws as unknown as RtWs;
							rt.data = upgradeOpts?.data;
							handlers.open?.(rt);
							ws.on("close", () => handlers.close?.(rt));
							ws.on("message", (raw: RawData) => handlers.message?.(rt, String(raw)));
						});
						return true;
					},
				};
				const response = await opts.fetch(request, srv);
				// fetch 未 upgrade(如鉴权失败的 401)→ 手写响应到裸 upgrade socket
				if (!handled) {
					const bodyText = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
					const headLines = [`HTTP/1.1 ${response.status} ${response.statusText || "OK"}`];
					response.headers.forEach((v, k) => headLines.push(`${k}: ${v}`));
					headLines.push(`content-length: ${bodyText.length}`, "connection: close", "", "");
					socket.write(headLines.join("\r\n") + bodyText.toString("binary"));
					socket.destroy();
				}
			})().catch(() => {
				try {
					socket.destroy();
				} catch {
					/* 已断 */
				}
			});
		});
	}

	// Node 的 listen 异步:同步读 address() 必是 null(Bun.serve 同步已绑,此为
	// 两运行时差异点)。绑定完成后才 resolve,调用方 await 后 port 恒为真值。
	httpServer.listen(opts.port ?? 0, opts.hostname ?? "127.0.0.1", () => {
		const boundPort = (httpServer.address() as AddressInfo)?.port ?? 0;
		resolveServe({
			port: boundPort,
			stop(closeActiveConnections = false) {
				if (wss) {
					for (const client of wss.clients) client.close();
					wss.close();
				}
				if (closeActiveConnections) {
					for (const socket of liveSockets) socket.destroy();
				}
				httpServer.close();
			},
		});
	});
}
