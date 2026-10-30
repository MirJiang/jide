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
import { DevServerManager } from "./host/devserver-manager";
import { BrowserAutomation } from "./host/browser-automation";
import { ChecksManager } from "./host/checks-manager";
import { ReviewQueue } from "./host/review-queue";
import { HttpProbe, TestRunner, mapFilesToTests } from "./host/test-runner";
import { readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";

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
const devservers = new DevServerManager();
const browsers = new BrowserAutomation(RUNTIME_ROOT);
const checks = new ChecksManager(browsers);
const runner = new TestRunner();
const review = new ReviewQueue(workspaces, RUNTIME_ROOT);
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
plans.setReviewQueue(review as any);
devservers.bindEmitter(emit);
browsers.bindEmitter(emit);
checks.bindEmitter(emit);
review.bindEmitter(emit);
checks.setCwdResolver((workspaceId) => workspaces.locate(workspaceId).cwd);

function scanTestFiles(cwd: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
			const relPath = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(pathJoin(dir, e.name), relPath, depth + 1);
			else if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) out.push(relPath);
		}
	};
	walk(cwd, "", 0);
	return out;
}

function scanTestFiles(cwd: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
			const relPath = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(pathJoin(dir, e.name), relPath, depth + 1);
			else if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) out.push(relPath);
		}
	};
	walk(cwd, "", 0);
	return out;
}

function scanTestFiles(cwd: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
			const relPath = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(pathJoin(dir, e.name), relPath, depth + 1);
			else if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) out.push(relPath);
		}
	};
	walk(cwd, "", 0);
	return out;
}

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

			/* ---------- 测试域 M3(4A-4F) ---------- */
			"devserver.ensure": async ({ workspaceId, command, cwd, port, probe, readyPattern }) => {
				const loc = workspaces.locate(workspaceId);
				if (!loc.cwd) return { ok: false, error: "工作区不存在" };
				const trust = workspaces.requireTrusted(loc.projectId!);
				if (!trust.ok) return { ok: false, error: trust.error };
				try {
					const r = await devservers.ensure(workspaceId, {
						command: command ?? "bunx vite --port " + (port ?? 5175),
						cwd: cwd ?? loc.cwd,
						port: port ?? 5175,
						probe: probe ?? "auto",
						readyPattern,
					});
					return r.ok
						? { ok: true, url: r.url, port: r.port, probeMode: r.probeMode, startedMs: r.startedMs }
						: { ok: false, error: r.error, logTail: r.logTail };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"devserver.stop": ({ workspaceId }) => {
				const r = devservers.stop(workspaceId);
				return r.ok ? { ok: true } : { ok: false, error: r.error };
			},
			"devserver.status": ({ workspaceId }) => devservers.status(workspaceId),

			"probe.http": ({ url, expectStatus, contains, jsonPath, jsonEquals }) =>
				HttpProbe.run(url, { expectStatus, contains, jsonPath, jsonEquals }),

			"test.run": async ({ workspaceId, scope, files }) => {
				const loc = workspaces.locate(workspaceId);
				if (!loc.cwd) return { ok: false, error: "工作区不存在" };
				const trust = workspaces.requireTrusted(loc.projectId!);
				if (!trust.ok) return { ok: false, error: trust.error };
				const allTests = scanTestFiles(loc.cwd);
				const changed: string[] = [];
				if (scope !== "all") {
					const st = await workspaces.gitStatus(workspaceId);
					if (st.ok) changed.push(...st.changes.map((c) => c.path));
					if (scope === "files" && files) changed.push(...files);
				}
				const selected = scope === "all" ? allTests : mapFilesToTests(changed, allTests);
				emit({ type: "test.progress", workspaceId, phase: "selecting", selected: selected.length, total: allTests.length, done: 0, passed: 0, failed: 0 });
				if (selected.length === 0 && scope !== "all") {
					return { ok: true, selected: 0, total: allTests.length, durationMs: 0, results: [] };
				}
				const r = await runner.run(loc.cwd, scope === "all" ? allTests : selected, allTests.length);
				const pass = r.results.filter((x) => x.status === "pass").length;
				const fail = r.results.filter((x) => x.status === "fail").length;
				emit({ type: "test.progress", workspaceId, phase: "done", selected: r.selected, total: r.total, done: r.results.length, passed: pass, failed: fail });
				return r.ok
					? { ok: true, selected: r.selected, total: r.total, durationMs: r.durationMs, results: r.results }
					: { ok: false, error: "runner 失败" };
			},

			"checks.list": ({ workspaceId }) => ({ ok: true, checks: checks.list(workspaceId) }),
			"checks.create": ({ workspaceId, title, kind, assertion, appliesTo }) => {
				const r = checks.create(workspaceId, title, kind, assertion, appliesTo);
				return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error };
			},
			"checks.run": ({ workspaceId, ids }) => checks.run(workspaceId, ids),
			"checks.delete": ({ workspaceId, id }) => checks.delete(workspaceId, id),

			"browser.navigate": async ({ workspaceId, url }) => {
				try {
					const r = await browsers.navigate(workspaceId, url);
					return r.ok ? { ok: true, title: r.title } : { ok: false, error: r.error };
				} catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},
			"browser.click": async ({ workspaceId, selector }) => {
				try {
					return await browsers.click(workspaceId, selector);
				} catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},
			"browser.capture": async ({ workspaceId, kind }) => {
				try {
					return await browsers.capture(workspaceId, kind);
				} catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},

			"run.agentSelfTest": async ({ workspaceId }) => {
				// ① Agent 自测:后台静默跑 选测 + 检查项(服务直调)
				const loc = workspaces.locate(workspaceId);
				if (!loc.cwd) return { ok: false, error: "工作区不存在" };
				const allTests = scanTestFiles(loc.cwd);
				const st = await workspaces.gitStatus(workspaceId);
				const changed = st.ok ? st.changes.map((c) => c.path) : [];
				const selected = mapFilesToTests(changed, allTests);
				const t = selected.length
					? await runner.run(loc.cwd, selected, allTests.length)
					: { selected: 0, total: allTests.length, results: [] as any[] };
				const c = await checks.run(workspaceId);
				const pass = t.results.filter((x: any) => x.status === "pass").length;
				const fail = t.results.filter((x: any) => x.status === "fail").length;
				const cPass = c.results.filter((x: any) => x.passed).length;
				const summary = `测试 ${pass}/${pass + fail}(选测 ${t.selected}/${t.total}) · 检查项 ${cPass}/${c.results.length}`;
				return { ok: true, summary };
			},

			"review.list": ({ projectId }) => ({ ok: true, items: review.list(projectId) }),
			"review.decide": ({ id, decision, note }) => review.decide(id, decision, note),

			"preview.open": ({ url }) => {
				// ② 人侧预览:内嵌窗口加载 dev server URL(与 agent 共用同一实例)
				try {
					if (previewWindow) (previewWindow as any).close?.();
					previewWindow = new BrowserWindow({
						title: "JIDE 预览",
						url,
						frame: { width: 520, height: 760, x: 1200, y: 120 },
					});
					emit({ type: "host.log", level: "info", message: "内嵌预览已打开:" + url });
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},

			"session.askWithContext": ({ workspaceId, source, contextText, question }) => {
				const loc = workspaces.locate(workspaceId);
				emit({ type: "host.log", level: "info", message: `[${source}] ${contextText.slice(0, 200)}` });
				return { ok: true };
			},
		} satisfies HostRequestHandlers as any,
		messages: {
			resync: ({ lastSeq }) => {
				for (const event of host.eventsSince(lastSeq)) emit(event);
			},
		},
	},
});

let previewWindow: BrowserWindow | null = null;

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
	devservers.stopAll();
	browsers.disposeAll();
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

/* E2E 冒烟钩子 3:JIDE_SMOKE_M3=<workspaceId> 走完 M3 闭环(日志可断言) */
if (process.env.JIDE_SMOKE_M3) {
	const wid = process.env.JIDE_SMOKE_M3;
	setTimeout(async () => {
		try {
			const srv = Bun.serve({
				port: 19777,
				hostname: "127.0.0.1",
				fetch: (req) => {
					const u = new URL(req.url);
					if (u.pathname === "/api/total") return Response.json({ total: { yuan: "89.70", cents: 8970 } });
					if (u.pathname === "/cart")
						return new Response(
							"<html><body><button id='add' onclick=\"this.textContent='added'\">加入购物车</button><div id='t'>89.70</div></body></html>",
							{ headers: { "content-type": "text/html" } },
						);
					return new Response("OK");
				},
			});
			const reqs = null; // 服务直调

			// 4B HTTP 探测
			const p = await HttpProbe.run("http://127.0.0.1:19777/api/total", { jsonPath: "total.yuan", jsonEquals: "89.70" });
			console.log("[jide:smoke-m3] probe:", JSON.stringify(p));

			// 4A dev server 就绪(http 探测模式)
			const ds = await devservers.ensure(wid, { command: "bun -e \"await Bun.sleep(120000)\"", cwd: process.cwd(), port: 19777, probe: "http" });
			console.log("[jide:smoke-m3] devserver:", JSON.stringify(ds).slice(0, 160));

			// 4D 智能选测(真实 bun test:contracts 用例)
			const allTests = scanTestFiles(workspaces.locate(wid).cwd ?? process.cwd());
			const t = await runner.run(workspaces.locate(wid).cwd ?? process.cwd(), ["packages/contracts/src/index.test.ts"], allTests.length);
			const tPass = t.results ? t.results.filter((x: any) => x.status === "pass").length : 0;
			const tFail = t.ok ? t.results.filter((x: any) => x.status === "fail").length : 0;
			console.log("[jide:smoke-m3] test:", t.ok ? "selected " + t.selected + "/" + t.total + " pass=" + tPass + " fail=" + tFail + " " + t.durationMs + "ms" : t.error);

			// 4C 浏览器:navigate → click → capture(截图回传)
			const nav = await browsers.navigate(wid, "http://127.0.0.1:19777/cart");
			console.log("[jide:smoke-m3] browser nav:", JSON.stringify(nav));
			const click = await browsers.click(wid, "#add");
			console.log("[jide:smoke-m3] browser click:", JSON.stringify(click));
			const cap = await browsers.capture(wid, "shot");
			console.log("[jide:smoke-m3] capture:", cap.ok ? "ok " + Math.round((cap.dataBase64.length * 0.75) / 1024) + "KB -> " + cap.path : cap.error);

			// 4E 检查项:创建资产 + 复验
			checks.create(wid, "总额展示 89.70", "asset", { type: "http", url: "http://127.0.0.1:19777/api/total", contains: "89.70" });
			const cr = await checks.run(wid);
			console.log("[jide:smoke-m3] checks:", JSON.stringify(cr).slice(0, 220));

			// ① Agent 自测(运行三档之一,后台静默)
			const passN = t.ok ? t.results.filter((x: any) => x.status === "pass").length : 0;
			const cPass = cr.ok ? cr.results.filter((x: any) => x.passed).length : 0;
			console.log("[jide:smoke-m3] agentSelfTest: ok 测试 " + passN + "/" + (t.ok ? t.results.length : 0) + " · 检查项 " + cPass + "/" + (cr.ok ? cr.results.length : 0));

			srv.stop(true);
			console.log("[jide:smoke-m3] ALL DONE");
		} catch (e) {
			console.log("[jide:smoke-m3] ERR", e);
		}
	}, 5000);
}
