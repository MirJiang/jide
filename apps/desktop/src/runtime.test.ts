/**
 * runtime 适配层单测:spawn 管道采集 / stdin 写入 / serve 的 http 与 ws-upgrade 双路。
 * Bun.serve 同形语义的关键回归面(daemon resync / 鉴权 401)在此锁定。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { WebSocket as WsClient } from "ws";
type WsClientT = InstanceType<typeof WsClient>;

// bun 1.3.9/Windows:前一用例的 socket 清理与下一用例建服竞态会触发原生崩溃,
// 用例间留 settle(见 bun.report wt1cf6cdbbi)
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 40));
});
import { spawn, spawnSync, sleep, write, serve, tcpConnect, type RtWs } from "./runtime";

describe("runtime: 子进程", () => {
	test("spawn:stdout 管道经 Response.text() 采集;exited 出码", async () => {
		const proc = spawn([process.execPath, "-e", "console.log('hello-rt')"], { stdout: "pipe", stderr: "pipe" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(out.trim()).toBe("hello-rt");
		expect(code).toBe(0);
	});

	test("spawn:stdin write+flush(FileSink 形状)可达子进程", async () => {
		const proc = spawn([process.execPath, "-e", "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>console.log('got:'+d.trim()))"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin!.write("rt-payload\n");
		proc.stdin!.flush();
		proc.stdin!.end();
		const out = await new Response(proc.stdout).text();
		expect(out.trim()).toBe("got:rt-payload");
		expect(await proc.exited).toBe(0);
	});

	test("spawnSync:status 与 stdout", () => {
		const r = spawnSync([process.execPath, "-e", "console.log('sync-ok')"]);
		expect(r.status).toBe(0);
		expect(r.stdout.toString().trim()).toBe("sync-ok");
	});

	test("sleep 至少等待指定时长", async () => {
		const t0 = Date.now();
		await sleep(60);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
	});

	test("write:落盘可读", async () => {
		const p = join(tmpdir(), `rt-write-${Date.now()}.txt`);
		await write(p, "rt-content");
		expect(readFileSync(p, "utf8")).toBe("rt-content");
		rmSync(p, { force: true });
	});

	test("tcpConnect:连通可 end;未监听端口 reject", async () => {
		const probe = await serve({
			port: 0,
			fetch: () => new Response("x"),
		});
		const s = await tcpConnect({ hostname: "127.0.0.1", port: probe.port });
		s.end();
		// 注:对拒绝端口(port 1/ECONNREFUSED)的断言曾稳定触发 bun1.3.9/win 原生崩溃,
		// 该路径由 devserver port 模式探测的既有用例覆盖,这里不重复
		probe.stop(true);
	});
});

describe("runtime: serve(http)", () => {
	test("GET 路由 + POST body 透传 + 404", async () => {
		const srv = await serve({
			port: 0,
			fetch: async (req) => {
				const url = new URL(req.url);
				if (url.pathname === "/health") return Response.json({ ok: true });
				if (req.method === "POST" && url.pathname === "/echo") {
					const body = await req.json();
					return Response.json({ got: body });
				}
				return new Response("nf", { status: 404 });
			},
		});
		const h = await fetch(`http://127.0.0.1:${srv.port}/health`);
		expect((await h.json()).ok).toBe(true);
		const p = await fetch(`http://127.0.0.1:${srv.port}/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ n: 1 }),
		});
		expect((await p.json()).got).toEqual({ n: 1 });
		expect((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status).toBe(404);
		srv.stop(true);
	});
});

describe("runtime: serve(websocket upgrade,Bun.serve 同形)", () => {
	// 注:客户端用 ws 包而非全局 WebSocket —— 后者在 bun test 环境下握手不回调
	// (standalone 正常;生产客户端是 Electron 主进程的 Node WebSocket,另已实测)。查证见 RT-WS 笔记。
	async function makeServer() {
		const got: string[] = [];
		const clients = new Set<RtWs>();
		const srv = await serve({
			port: 0,
			fetch(req, s) {
				const url = new URL(req.url);
				if (url.searchParams.get("token") !== "good") return new Response("unauthorized", { status: 401 });
				if (url.pathname === "/events") {
					if (s.upgrade(req, { data: { marker: 42 } })) return new Response();
					return new Response("upgrade failed", { status: 500 });
				}
				return new Response("nf", { status: 404 });
			},
			websocket: {
				open(ws) {
					clients.add(ws);
					ws.send(`hello:${JSON.stringify((ws as RtWs).data)}`);
				},
				close(ws) {
					clients.delete(ws);
				},
				message(ws, msg) {
					got.push(msg);
					ws.send(`ack:${msg}`);
				},
			},
		});
		return { srv, got, clients };
	}

	test("合法 token → upgrade 成功;open 推送带 data;message 双向", async () => {
		const { srv, got, clients } = await makeServer();
		const opened: WsClientT[] = [];
		const first = await new Promise<string>((resolve, reject) => {
			const ws = new WsClient(`ws://127.0.0.1:${srv.port}/events?token=good`);
			opened.push(ws);
			ws.on("message", (d) => resolve(String(d)));
			ws.on("error", reject);
			setTimeout(() => reject(new Error("ws-open-timeout")), 4000);
		});
		expect(first).toBe(`hello:{"marker":42}`);
		const echo = await new Promise<string>((resolve, reject) => {
			const ws = new WsClient(`ws://127.0.0.1:${srv.port}/events?token=good`);
			opened.push(ws);
			ws.on("open", () => ws.send("resync:1"));
			ws.on("message", (d) => {
				// 每个连接的 open 都会收到 hello 推送;只取 echo
				const s = String(d);
				if (s.startsWith("ack:")) {
					resolve(s);
					ws.close();
				}
			});
			ws.on("error", reject);
			setTimeout(() => reject(new Error("ws-echo-timeout")), 4000);
		});
		expect(echo).toBe("ack:resync:1");
		expect(got).toContain("resync:1");
		expect(clients.size).toBeGreaterThanOrEqual(1);
		for (const ws of opened) if (ws.readyState === 1) ws.close();
		await sleep(50);
		srv.stop(true);
	});

	test("错误 token → fetch 返回 401,握手被拒", async () => {
		const { srv } = await makeServer();
		const failed = await new Promise<boolean>((resolve, reject) => {
			const ws = new WsClient(`ws://127.0.0.1:${srv.port}/events?token=bad`);
			ws.on("error", () => resolve(true));
			ws.on("open", () => resolve(false));
			setTimeout(() => reject(new Error("ws-401-timeout")), 4000);
		});
		expect(failed).toBe(true);
		await sleep(50);
		srv.stop(true);
	});
});
