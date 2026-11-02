/**
 * ToolBridgeServer — pi 子进程内扩展回环调用宿主服务的 HTTP 桥(工具桥,§4 工具协议表)
 *
 * 架构:JIDE 的 8 个领域工具(dev_server/http_probe/browser/test_run/checks/plan/
 * memory_suggest/git_diff_files)注册在 pi 进程内的 jide-tools.ts 扩展;execute 时经
 * 本桥回环调宿主服务。宿主按 workspaceId 路由,格式化后的 AgentToolResult 形状返回。
 *
 * 传输与安全:
 *  - 仅绑定 127.0.0.1,serve({port:0}) 随机端口(实测宿主 runtime 支持,见 index.ts 预览页);
 *  - 每实例随机 Bearer token,spawn 时经 env(JIDE_BRIDGE_URL/JIDE_BRIDGE_TOKEN)注入
 *    给自己拉起的 pi 子进程;无/错 token 一律 401;
 *  - 协议:POST /tool/<name>,body={workspaceId,params};处理器异常返回 200+isError 结果
 *    (agent 看到错误文本),协议层错误 400/401/404。
 */

import { serve } from "../../runtime";

export interface BridgeToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	isError?: boolean;
}

export type BridgeToolHandler = (
	workspaceId: string,
	params: Record<string, any>,
) => Promise<BridgeToolResult>;

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ToolBridgeServer {
	private port: number | null = null;
	private stopFn: (() => void) | null = null;
	private handlers = new Map<string, BridgeToolHandler>();
	readonly token = randomToken();

	register(name: string, handler: BridgeToolHandler): this {
		this.handlers.set(name, handler);
		return this;
	}

	/** 启动(幂等)并返回注入给 pi 扩展的环境信息;未注册任何处理器时返回 null。
	 * 异步:Node listen 异步,await serve() 后端口恒为真值。 */
	async start(): Promise<{ url: string; token: string } | null> {
		if (this.handlers.size === 0) return null;
		if (this.port !== null) return { url: `http://127.0.0.1:${this.port}`, token: this.token };
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => this.handle(req),
		});
		this.port = server.port;
		this.stopFn = () => server.stop(true);
		return { url: `http://127.0.0.1:${this.port}`, token: this.token };
	}

	stop() {
		this.stopFn?.();
		this.stopFn = null;
		this.port = null;
	}

	get running(): boolean {
		return this.port !== null;
	}

	private handle(req: Request): Response | Promise<Response> {
		if (req.method !== "POST") return json(405, { error: "仅支持 POST" });
		const auth = req.headers.get("authorization") ?? "";
		if (auth !== `Bearer ${this.token}`) return json(401, { error: "未授权" });
		const m = req.url.match(/\/tool\/([A-Za-z0-9_]+)$/);
		if (!m) return json(404, { error: "路径须为 /tool/<name>" });
		const handler = this.handlers.get(m[1]);
		if (!handler) return json(404, { error: `未知工具:${m[1]}` });

			return (async () => {
				let body: { workspaceId?: string; params?: Record<string, any> };
				try {
					body = await req.json();
				} catch {
					return json(400, { error: "body 须为 JSON {workspaceId, params}" });
				}
				// workspaceId:会话 env 优先,模型显式传参兜底(常驻 Router 无自身工作区,靠 params 定目标);
				// 仍缺时交由处理器返回可读错误(不在此硬 400)
				const wsId = body.workspaceId ?? (typeof body.params?.workspaceId === "string" ? body.params.workspaceId : "");
				try {
					const result = await handler(wsId, body.params ?? {});
					return json(200, result);
				} catch (err: any) {
					// 处理器异常 → 工具错误结果(agent 能读到错误文本),而非协议失败
					return json(200, {
						content: [{ type: "text", text: String(err?.message ?? err) }],
						details: undefined,
						isError: true,
					} satisfies BridgeToolResult);
				}
			})();
	}
}

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}
