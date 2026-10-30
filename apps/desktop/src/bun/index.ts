/**
 * JIDE 主进程入口:窗口 + RPC(electrobun/main)
 *
 * UI↔宿主通信走 @jide/contracts:
 *  - requests:app/session/project/workspace/fs/terminal/plan/git(UI → 宿主,枚举于 contracts)
 *  - messages:bun.messages.resync(view→bun 回放同步)/ webview.messages.event(bun→view 事件流)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { BrowserView, BrowserWindow, Updater } from "electrobun/main";
import type { RPCSchema } from "electrobun/main";
import type {
	HostRequestShapes,
	HostEvent,
	HostRequestHandlers,
} from "@jide/contracts";
import { PROTOCOL_VERSION, isHostEvent } from "@jide/contracts";
import { AgentHost, HOST_NAME } from "./host/agent-host";
import { WorkspaceManager } from "./host/workspace-manager";
import { FileService } from "./host/file-service";
import { TerminalManager } from "./host/terminal-manager";
import { PlanManager } from "./host/plan-manager";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/** M1:demo 模式默认开(faux 全链路本地演练);真实模型接入后改为可配置 */
const DEMO_DEFAULT = process.env.JIDE_DEMO !== "0";

/** 运行时数据(信任状态/会话文件)固定在用户目录,不随 build 目录重建丢失 */
const RUNTIME_ROOT = process.env.JIDE_HOME ?? join(homedir(), ".jide");

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`[jide] HMR enabled: ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log("[jide] Vite dev server 未运行,使用打包视图");
		}
	}
	return "views://mainview/index.html";
}

/* ---------------- RPC schema(由 contracts 派生,单事件通道) ---------------- */

type JideRPC = {
	bun: RPCSchema<{
		requests: {
			[K in keyof HostRequestShapes]: {
				params: HostRequestShapes[K]["params"];
				response: HostRequestShapes[K]["response"];
			};
		};
		messages: {
			/** UI 报告已消费到的 seq,宿主据此补发缺口(连接/重连回放) */
			resync: { lastSeq: number };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			/** 宿主 → UI 的唯一推送通道:协议事件流 */
			event: HostEvent;
		};
	}>;
};

const host = new AgentHost();
const workspaces = new WorkspaceManager(RUNTIME_ROOT);
const files = new FileService(workspaces);
const terminals = new TerminalManager();
const plans = new PlanManager(workspaces, RUNTIME_ROOT);

const emit = (e: HostEvent) => {
	if (!isHostEvent(e)) return;
	(mainWindow.webview.rpc as any)?.send?.event(e);
	if (e.type === "host.log") console.log(`[jide:host] ${e.level} ${e.message}`);
};
host.bindEmitter(emit);
workspaces.bindEmitter(emit);
terminals.bindEmitter(emit);
plans.bindEmitter(emit);

const rpc = BrowserView.defineRPC<JideRPC>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			/* ---------- 协议与会话 ---------- */
			"app.hello": ({ protocolVersion }) => {
				if (protocolVersion !== PROTOCOL_VERSION) {
					return {
						ok: false,
						error: `协议不兼容:UI=${protocolVersion}`,
						expectedProtocolVersion: PROTOCOL_VERSION,
					};
				}
				return {
					ok: true,
					protocolVersion: PROTOCOL_VERSION,
					host: HOST_NAME,
					demo: DEMO_DEFAULT,
				};
			},
			"session.create": async ({ workspacePath, demoMode }) => {
				try {
					const entry = await host.createSession({
						workspacePath,
						demoMode: demoMode ?? DEMO_DEFAULT,
					});
					return {
						ok: true,
						sessionId: entry.sessionId,
						modelLabel: entry.modelLabel,
						demo: entry.demo,
					};
				} catch (err: any) {
					host.log("error", `会话创建失败:${err?.message ?? err}`);
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.prompt": async ({ sessionId, text }) => {
				try {
					await host.prompt(sessionId, text);
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.abort": async ({ sessionId }) => {
				try {
					await host.abort(sessionId);
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.rebuild": async ({ sessionId }) => {
				try {
					const { entry, restored } = await host.rebuild(sessionId);
					return {
						ok: true,
						sessionId: entry.sessionId,
						restoredMessages: restored,
					};
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.get": ({ sessionId }) => {
				const snap = host.getSnapshot(sessionId);
				if (!snap) return { ok: false, error: `会话不存在:${sessionId}` };
				return { ok: true, ...snap };
			},

			/* ---------- 工作区(W1-W4) ---------- */
			"project.open": async ({ path }) => {
				const r = await workspaces.openProject(path);
				if (!r.opened) return { ok: false, error: r.reason };
				return {
					ok: true,
					projectId: r.project.id,
					root: r.project.root,
					name: r.project.name,
					trusted: r.project.trusted,
					isRepo: true,
					branch: r.branch,
				};
			},
			"project.trust": ({ projectId }) => {
				const ok = workspaces.trustProject(projectId);
				return ok ? { ok: true, trusted: true } : { ok: false, error: "项目未打开" };
			},
			"workspace.list": async ({ projectId }) => {
				const list = await workspaces.listWorkspaces(projectId);
				const rec = workspaces.getProject(projectId);
				return {
					ok: true,
					activeWorkspaceId: rec?.activeWorkspaceId ?? list[0]?.id ?? null,
					workspaces: list.map((w) => ({
						id: w.id,
						kind: w.kind,
						branch: w.branch,
						path: w.path,
						baseRef: w.baseRef,
					})),
				};
			},
			"workspace.create": async ({ projectId, name, fromRef }) => {
				const r = await workspaces.createWorktree(projectId, name, fromRef);
				return r.ok
					? { ok: true, workspaceId: r.workspaceId, path: r.path, branch: r.branch }
					: { ok: false, error: r.error };
			},
			"workspace.switch": async ({ projectId, workspaceId }) => {
				const r = await workspaces.switchWorkspace(projectId, workspaceId);
				return r.ok ? { ok: true, activeWorkspaceId: r.activeWorkspaceId } : { ok: false, error: r.error };
			},

			/* ---------- 文件 ---------- */
			"fs.list": ({ workspaceId, relPath }) => {
				const r = files.list(workspaceId, relPath);
				return r.ok ? { ok: true, entries: r.entries } : { ok: false, error: r.error };
			},
			"fs.read": ({ workspaceId, relPath }) => {
				const r = files.read(workspaceId, relPath);
				return r.ok ? { ok: true, content: r.content, size: r.size } : { ok: false, error: r.error };
			},
			"fs.write": ({ workspaceId, relPath, content }) => {
				const r = files.write(workspaceId, relPath, content);
				return r.ok ? { ok: true } : { ok: false, error: r.error };
			},

			/* ---------- 终端 ---------- */
			"terminal.create": ({ workspaceId, cwd }) => {
				// 终端属于命令执行 → 信任门
				const { projectId } = workspaces.locate(workspaceId);
				if (projectId) {
					const t = workspaces.requireTrusted(projectId);
					if (!t.ok) return { ok: false, error: t.error };
				} else {
					return { ok: false, error: "工作区不存在" };
				}
				const entry = terminals.create(workspaceId, cwd ?? undefined);
				return { ok: true, terminalId: entry.id };
			},
			"terminal.write": ({ terminalId, data }) => {
				const r = terminals.write(terminalId, data);
				return r.ok ? { ok: true } : { ok: false, error: r.error };
			},
			"terminal.resize": ({ terminalId, cols, rows }) => {
				const r = terminals.resize(terminalId, cols, rows);
				return r.ok ? { ok: true } : { ok: false, error: r.error };
			},
			"terminal.dispose": ({ terminalId }) => {
				const r = terminals.dispose(terminalId);
				return r.ok ? { ok: true } : { ok: false, error: r.error };
			},

			/* ---------- 计划(W5) ---------- */
			"plan.create": ({ workspaceId, goal, steps }) => {
				const { projectId } = workspaces.locate(workspaceId);
				if (projectId) {
					const t = workspaces.requireTrusted(projectId);
					if (!t.ok) return { ok: false, error: t.error };
				}
				const plan = plans.create(workspaceId, goal, steps);
				return { ok: true, planId: plan.id };
			},
			"plan.stepDone": async ({ planId, stepIndex }) => {
				const r = await plans.stepDone(planId, stepIndex);
				return r.ok
					? { ok: true, ...(r.commit ? { commit: r.commit } : {}) }
					: { ok: false, error: r.error };
			},
			"plan.get": ({ workspaceId }) => {
				const plan = plans.getByWorkspace(workspaceId);
				return {
					ok: true,
					plan: plan
						? {
								planId: plan.id,
								goal: plan.goal,
								steps: plan.steps.map((st) => ({
									text: st.text,
									state: st.state,
									...(st.commit ? { commit: st.commit } : {}),
								})),
						  }
						: null,
				};
			},

			/* ---------- Git 呈现 ---------- */
			"git.status": async ({ workspaceId }) => {
				const r = await workspaces.gitStatus(workspaceId);
				return r.ok
					? { ok: true, branch: r.branch, changes: r.changes, ahead: r.ahead, behind: r.behind }
					: { ok: false, error: r.error };
			},
			"git.log": async ({ workspaceId, limit }) => {
				const r = await workspaces.gitLog(workspaceId, limit);
				return r.ok ? { ok: true, commits: r.commits } : { ok: false, error: r.error };
			},
		} satisfies HostRequestHandlers as any,
		messages: {
			resync: ({ lastSeq }) => {
				for (const event of host.eventsSince(lastSeq)) emit(event);
			},
		},
	},
});

const mainWindow = new BrowserWindow({
	title: "JIDE",
	url: await getMainViewUrl(),
	rpc,
	frame: {
		width: 1360,
		height: 860,
		x: 120,
		y: 80,
	},
});

mainWindow.on("close", () => {
	terminals.disposeAll();
	host.disposeAll();
});

console.log(
	`[jide] 主进程就绪 · host=${HOST_NAME} · protocol=v${PROTOCOL_VERSION} · demo=${DEMO_DEFAULT}`,
);

/* E2E 冒烟钩子:JIDE_SMOKE_PLAN=<完整workspaceId> 自动建计划并推进两步(W5 自动提交,日志可断言) */
if (process.env.JIDE_SMOKE_PLAN) {
	const wid = process.env.JIDE_SMOKE_PLAN;
	setTimeout(async () => {
		try {
			await workspaces.listWorkspaces(wid.split(":")[0]);
			const wspath = workspaces.locate(wid).cwd;
			if (wspath) await Bun.write(wspath + "/smoke-cart.ts", "export const priceCents = 2990;\n");
			const plan = plans.create(wid, "修复购物车总额浮点 bug", [
				"定位总额计算逻辑",
				"改为分单位整数计算",
				"回归验证",
				"浏览器验证展示",
				"沉淀检查项",
			]);
			console.log(`[jide:smoke-plan] plan created ${plan.id} on ${wid}`);
			const r1 = await plans.stepDone(plan.id, 0);
			console.log(`[jide:smoke-plan] step1 commit=${r1.ok ? (r1.commit?.sha ?? "none(no changes)") : r1.error}`);
			const r2 = await plans.stepDone(plan.id, 1);
			console.log(`[jide:smoke-plan] step2 commit=${r2.ok ? (r2.commit?.sha ?? "none(no changes)") : r2.error}`);
		} catch (e) {
			console.log(`[jide:smoke-plan] err ${e}`);
		}
	}, 4000);
}
