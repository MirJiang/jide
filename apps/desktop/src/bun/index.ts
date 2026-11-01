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
import { openFileDialog } from "electrobun/main/utils";
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
import { MemoryManager } from "./host/memory-manager";
import { SettingsManager } from "./host/settings-manager";
import { CredentialStore } from "./host/credential-store";
import { ToolBridgeServer, type BridgeToolResult } from "./host/bridge-server";
import { DevLogPump } from "./host/dev-log-pump";
import { ModelCatalog } from "./host/model-catalog";
import { AutomationManager } from "./host/automation-manager";
import { parseModelKey } from "@jide/contracts";
import { mapFilesToTests as mapTests } from "./host/test-runner";
import { HttpProbe, TestRunner } from "./host/test-runner";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

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
/* 日志回喂泵("AI 实时看日志"):dev server 错误 → steer 插队运行中会话;须在 emit 定义前创建 */
const logPump = new DevLogPump(host);
const workspaces = new WorkspaceManager(RUNTIME_ROOT);
const files = new FileService(workspaces);
const settings = new SettingsManager(RUNTIME_ROOT);
const terminals = new TerminalManager(() => settings.get().terminalShell);
const devservers = new DevServerManager();
const browsers = new BrowserAutomation(RUNTIME_ROOT);
const checks = new ChecksManager(browsers);
const runner = new TestRunner();
const review = new ReviewQueue(workspaces, RUNTIME_ROOT);
const memories = new Map<string, MemoryManager>();
const creds = new CredentialStore();
/** pi 模型目录缓存(get_available_models;临时 pi 进程查询) */
const modelCatalog = new ModelCatalog();

const memoryFor = (workspaceId: string): MemoryManager | null => {
	const { cwd } = workspaces.locate(workspaceId);
	if (!cwd) return null;
	let m = memories.get(workspaceId);
	if (!m) {
		m = new MemoryManager(cwd);
		m.bindEmitter(emit);
		memories.set(workspaceId, m);
	}
	return m;
};
const plans = new PlanManager(workspaces, RUNTIME_ROOT);

/* ---------- 自动化域(P1.5):定时/事件驱动 → 会话 → 自动验证 → 评审队列 ---------- */
const automations = new AutomationManager({
	host,
	workspaces,
	runtimeRoot: RUNTIME_ROOT,
	verify: {
		scanTests: scanTestFiles,
		gitStatus: (workspaceId) => workspaces.gitStatus(workspaceId),
		mapTests: mapTests,
		runTests: (cwd, files, total) => runner.run(cwd, files, total),
		runChecks: (workspaceId) => checks.run(workspaceId),
		enqueueChecks: (workspaceId, passed, total) => review.enqueueChecks(workspaceId, passed, total),
	},
});

const emit = (e: HostEvent) => {
	if (!isHostEvent(e)) return;
	(mainWindow.webview.rpc as any)?.send?.event(e);
	if (e.type === "host.log") console.log(`[jide:host] ${e.level} ${e.message}`);
	logPump.handleHostEvent(e);
	automations.handleHostEvent(e);
};
host.bindEmitter(emit);
logPump.bindEmitter(emit);
workspaces.bindEmitter(emit);
terminals.bindEmitter(emit);
plans.bindEmitter(emit);
plans.setReviewQueue(review as any);
devservers.bindEmitter(emit);
browsers.bindEmitter(emit);
checks.bindEmitter(emit);
review.bindEmitter(emit);
automations.bindEmitter(emit);
automations.start();
checks.setCwdResolver((workspaceId) => workspaces.locate(workspaceId).cwd);

/* ---------- 工具桥:pi 进程内 jide-tools 扩展回环调用宿主服务(§4 工具协议表) ---------- */
const brText = (t: string, isError?: boolean): BridgeToolResult => ({
	content: [{ type: "text", text: t }],
	details: undefined,
	...(isError ? { isError: true } : {}),
});

const bridge = new ToolBridgeServer();

bridge.register("dev_server", async (workspaceId, p) => {
	if (p.action === "stop") {
		const r = await devservers.stop(workspaceId);
		return brText(r.ok ? "dev server 已停止" : r.error, !r.ok);
	}
	if (p.action === "status") {
		return brText(JSON.stringify(devservers.status(workspaceId)));
	}
	const loc = workspaces.locate(workspaceId);
	if (!loc.cwd) return brText("工作区不存在", true);
	const trust = workspaces.requireTrusted(loc.projectId!);
	if (!trust.ok) return brText(trust.error, true);
	const r = await devservers.ensure(workspaceId, {
		command: p.command ?? `bunx vite --port ${p.port ?? 5175}`,
		cwd: loc.cwd,
		port: p.port ?? 5175,
		probe: p.probe ?? "auto",
	});
	if (!r.ok) return brText(`启动失败:${r.error}\n日志尾:\n${r.logTail ?? "(空)"}`, true);
	return brText(`就绪 url=${r.url} probe=${r.probeMode} ${r.startedMs}ms`);
});

bridge.register("http_probe", async (_wid, p) => {
	const r = await HttpProbe.run(p.url, {
		expectStatus: p.expectStatus,
		contains: p.contains,
		jsonPath: p.jsonPath,
		jsonEquals: p.jsonEquals,
	});
	if (!r.ok) return brText(`探测失败:${r.error}`, true);
	return brText(`passed=${r.passed} actual=${r.actual}${r.detail ? ` detail=${r.detail}` : ""}`);
});

bridge.register("browser", async (workspaceId, p) => {
	try {
		switch (p.action) {
			case "navigate": {
				if (!p.url) return brText("参数不足:url 必填", true);
				const r = await browsers.navigate(workspaceId, p.url);
				return r.ok ? brText(`已打开:${p.url}${r.title ? ` (title=${r.title})` : ""}`) : brText(r.error, true);
			}
			case "click": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.click(workspaceId, p.selector);
				return r.ok ? brText(`已点击 ${p.selector}`) : brText(`${r.error}(可稍后重试)`, true);
			}
			case "fill": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.fill(workspaceId, p.selector, p.value ?? "");
				return r.ok ? brText(`已填写 ${p.selector}`) : brText(r.error, true);
			}
			case "hover": {
				if (!p.selector) return brText("参数不足:selector 必填", true);
				const r = await browsers.hover(workspaceId, p.selector);
				return r.ok ? brText(`已 hover ${p.selector}`) : brText(r.error, true);
			}
			case "scroll": {
				await browsers.scroll(workspaceId, p.x ?? 0, p.y ?? 300, p.selector);
				return brText("已滚动");
			}
			case "snapshot": {
				const r = await browsers.snapshot(workspaceId);
				return r.ok ? brText("DOM 快照:\n" + r.outline.slice(0, 2000)) : brText(r.error, true);
			}
			case "console": {
				const msgs = browsers.consoleMessages(workspaceId, 30);
				return brText(msgs.length ? msgs.join("\n") : "(控制台无输出)");
			}
			case "record": {
				const r = await browsers.record(workspaceId, Math.min(p.ms ?? 5000, 30000), 500);
				return r.ok ? brText(`录屏 ${r.frames} 帧 → ${r.dir}(replay.html 可回放)`) : brText(r.error, true);
			}
			case "capture": {
				const r = await browsers.capture(workspaceId, "shot");
				return r.ok
					? brText(`截图已回传:${r.path}(${Math.round((r.dataBase64.length * 0.75) / 1024)}KB)`)
					: brText(r.error, true);
			}
			default:
				return brText("参数不足:action 不识别", true);
		}
	} catch (err: any) {
		return brText(String(err?.message ?? err), true);
	}
});

bridge.register("test_run", async (workspaceId, p) => {
	const loc = workspaces.locate(workspaceId);
	if (!loc.cwd) return brText("工作区不存在", true);
	const trust = workspaces.requireTrusted(loc.projectId!);
	if (!trust.ok) return brText(trust.error, true);
	const allTests = scanTestFiles(loc.cwd);
	const changed: string[] = [];
	if (p.scope !== "all") {
		const st = await workspaces.gitStatus(workspaceId);
		if (st.ok) changed.push(...st.changes.map((c: any) => c.path));
	}
	const selected = p.scope === "all" ? allTests : mapTests(changed, allTests);
	emit({ type: "test.progress", workspaceId, phase: "selecting", selected: selected.length, total: allTests.length, done: 0, passed: 0, failed: 0 });
	if (!selected.length) {
		return brText(`选测 0/${allTests.length}(无关联用例);如需回归请 scope=all`);
	}
	const r = await runner.run(loc.cwd, selected, allTests.length);
	const pass = r.results.filter((x: any) => x.status === "pass").length;
	const fail = r.results.filter((x: any) => x.status === "fail").length;
	emit({ type: "test.progress", workspaceId, phase: "done", selected: r.selected, total: r.total, done: r.results.length, passed: pass, failed: fail });
	const lines = r.results.map(
		(x: any) =>
			`${x.status === "pass" ? "✓" : x.status === "fail" ? "✗" : "–"} ${x.name} ${x.durationMs}ms${x.message ? "\n    " + String(x.message).slice(0, 300) : ""}`,
	);
	return brText(`选测 ${selected.length}/${allTests.length} · 通过 ${pass} · 失败 ${fail} · ${r.durationMs}ms\n${lines.join("\n")}`);
});

bridge.register("checks", async (workspaceId, p) => {
	if (p.action === "create") {
		if (!p.title || !p.assertion) return brText("参数不足:create 需 title 与 assertion", true);
		const r = checks.create(workspaceId, p.title, p.kind ?? "asset", p.assertion);
		return r.ok ? brText(`已创建检查项 ${r.id}(${p.title})`) : brText(r.error, true);
	}
	const r = await checks.run(workspaceId, p.ids);
	if (!r.ok) return brText(r.error ?? "检查项运行失败", true);
	// W6:检查项结果入评审队列(与 UI 路径一致)
	if (r.results.length) {
		review.enqueueChecks(workspaceId, r.results.filter((x: any) => x.passed).length, r.results.length);
	}
	const lines = r.results.map((x: any) => `${x.passed ? "✓" : "✗"} ${x.title}${x.detail ? " · " + x.detail : ""}`);
	return brText(`检查项 ${r.results.filter((x: any) => x.passed).length}/${r.results.length} 通过\n${lines.join("\n")}`);
});

bridge.register("plan", async (workspaceId, p) => {
	if (p.action === "create") {
		if (!p.goal || !p.steps) return brText("参数不足:create 需 goal 与 steps", true);
		const loc = workspaces.locate(workspaceId);
		if (loc.projectId) {
			const t = workspaces.requireTrusted(loc.projectId);
			if (!t.ok) return brText(t.error, true);
		}
		plans.create(workspaceId, p.goal, p.steps);
		return brText(`计划已建立(${p.steps.length} 步),面板可见;逐步执行后用 step_done 推进`);
	}
	if (p.stepIndex === undefined) return brText("参数不足:step_done 需 stepIndex", true);
	const cur = plans.getByWorkspace(workspaceId);
	if (!cur) return brText("当前工作区无进行中计划,先 create", true);
	const r = await plans.stepDone(cur.id, p.stepIndex);
	return r.ok
		? brText(`步骤 ${p.stepIndex + 1} 完成${r.commit ? `,自动提交 ${r.commit.sha}` : ""}`)
		: brText(r.error, true);
});

bridge.register("memory_suggest", async (workspaceId, p) => {
	const m = memoryFor(workspaceId);
	if (!m) return brText("工作区不存在", true);
	m.suggest(p.scope, p.file, p.lines, p.reason);
	return brText(`已生成记忆建议卡片(${p.file},${p.lines.length} 条),等待用户采纳`);
});

bridge.register("git_diff_files", async (workspaceId) => {
	const st = await workspaces.gitStatus(workspaceId);
	if (!st.ok) return brText(st.error, true);
	const paths = st.changes.map((c) => c.path);
	return brText(paths.length ? paths.join("\n") : "(无变更)");
});

bridge.register("terminal_read", async (workspaceId, p) => {
	const list = terminals.listByWorkspace(workspaceId);
	if (!list.length) {
		return brText("当前工作区没有终端(用户尚未在底部面板打开);可请用户开一个,或改用 bash 工具执行命令", true);
	}
	const id = p.terminalId && list.some((t) => t.id === p.terminalId) ? p.terminalId : list[list.length - 1].id;
	const r = terminals.tail(id, Math.min(p.lines ?? 40, 500));
	if (!r.ok) return brText(r.error, true);
	return brText(`[终端 ${id}] 最近输出(尾部 ${r.lines.length} 行):\n${r.lines.join("\n") || "(暂无输出)"}`);
});

bridge.register("terminal_send", async (workspaceId, p) => {
	if (!p.text) return brText("参数不足:text 必填", true);
	const loc = workspaces.locate(workspaceId);
	if (loc.projectId) {
		const t = workspaces.requireTrusted(loc.projectId);
		if (!t.ok) return brText(t.error, true);
	}
	const list = terminals.listByWorkspace(workspaceId);
	if (!list.length) return brText("当前工作区没有终端;可请用户在底部面板打开一个", true);
	const id = p.terminalId && list.some((t) => t.id === p.terminalId) ? p.terminalId : list[list.length - 1].id;
	const r = terminals.write(id, p.text + (p.enter === false ? "" : "\r"));
	return r.ok
		? brText(`已发送到终端 ${id}${p.enter === false ? "(未回车)" : ""};稍后用 terminal_read 查看结果`)
		: brText(r.error, true);
});

host.bindBridge(bridge);

/* dev server 逐行日志 → 回喂泵(错误检测 + 节流) */
devservers.onLogLine = (workspaceId, line) => logPump.onLine(workspaceId, line);


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
			};
			},
			"session.create": async ({ workspacePath }) => {
				try {
					// M4:三级记忆注入(项目层/用户层预算内)→ 宿主写入会话目录,
					// pi 进程内 jide-memory 扩展经 before_agent_start 注入 systemPrompt。
					// AGENTS.md 由 pi 原生发现加载;危险命令门禁由 pi 进程内 jide-guard
					// 扩展拦截(豁免表运行时读 <cwd>/.jide/allow-dangerous.json);
					// 工具桥:jide-tools 扩展经 ToolBridgeServer 回环调用宿主服务(按 workspaceId 路由)。
					let memoryContext: string | undefined;
					const memByPath = [...memories.entries()].find(([, m]) => (m as any).cwd === workspacePath)?.[1];
					if (memByPath) {
						const inj = memByPath.inject([]);
						memoryContext = inj.text || undefined;
					}
					let workspaceId: string | undefined;
					try {
						workspaceId = (await workspaces.findByPath(workspacePath))?.workspaceId;
					} catch {
						/* 反查失败不阻塞会话创建(工具返回明确错误) */
					}
					// 新会话默认模型(settings.defaultModel;空 = pi 默认)
					const modelKey = settings.get().defaultModel;
					const model = parseModelKey(modelKey) ?? undefined;
					const entry = await host.createSession({ workspacePath, memoryContext, workspaceId, model });
					return {
						ok: true,
						sessionId: entry.sessionId,
						modelLabel: entry.modelLabel,
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
			"session.respondUI": ({ sessionId, requestId, value, confirmed, cancelled }) => {
				try {
					host.respondUI(sessionId, { requestId, value, confirmed, cancelled });
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"session.setModel": async ({ sessionId, provider, modelId }) => {
				try {
					const modelLabel = await host.setModel(sessionId, provider, modelId);
					return { ok: true, modelLabel };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"models.list": async ({ refresh }) => {
				try {
					const models = await modelCatalog.list(refresh === true);
					return { ok: true, models };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},

			/* ---------- 自动化域(P1.5) ---------- */
			"automations.list": () => {
				const { automations: list, runs } = automations.list();
				return { ok: true, automations: list, runs };
			},
			"automations.save": ({ automation }) => {
				try {
					const saved = automations.save(automation);
					return { ok: true, automation: saved };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"automations.delete": ({ id }) => {
				try {
					automations.delete(id);
					return { ok: true };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"automations.run": async ({ id }) => {
				try {
					const rec = await automations.run(id, "manual");
					return { ok: true, runId: rec.id };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"automations.runs": ({ id }) => {
				return { ok: true, runs: automations.list().runs[id] ?? [] };
			},

			/* ---------- 工作区(W1-W4) ---------- */
			"settings.get": () => {
				return { ok: true, settings: settings.get() };
			},
			"settings.set": ({ patch }) => {
				return { ok: true, settings: settings.set(patch) };
			},
			"credential.list": async () => {
				try {
					return { ok: true, names: await creds.listUsers() };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"credential.set": async ({ name, secret }) => {
				const r = await creds.set(name, secret);
				return r.ok ? { ok: true } : { ok: false, error: r.error ?? "凭据写入失败" };
			},
			"credential.delete": async ({ name }) => {
				await creds.delete(name);
				return { ok: true };
			},
			"project.pickFolder": async () => {
				try {
					const paths = await openFileDialog({
						startingFolder: homedir(),
						allowedFileTypes: "*",
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					});
					return { ok: true, folder: paths[0] ?? null };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"project.clone": async ({ url, dir }) => {
				try {
					const target = dir.replace(/[\\/]+$/, "");
					if (!/^https?:\/\/|git@|ssh:\/\//.test(url)) return { ok: false, error: "远程地址格式不合法" };
					const proc = Bun.spawn(["git", "clone", "--progress", url, target], { stdout: "pipe", stderr: "pipe" });
					const err = await new Response(proc.stderr).text();
					const code = await proc.exited;
					if (code !== 0) {
						const lines = err.trim().split(/\r?\n/).filter(Boolean);
						return { ok: false, error: lines[lines.length - 1] ?? "克隆失败" };
					}
					return { ok: true, folder: target };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
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
				if (!r.ok) return { ok: false, error: r.error };
				// W3 会话模板:把源工作区最近一条会话复制到新工作区会话目录(agent 上下文延续)
				try {
					const rec = workspaces.getProject(projectId);
					if (rec) {
						const srcDir = join(RUNTIME_ROOT, "sessions", rec.root.replace(/[^a-zA-Z0-9_-]+/g, "--"));
						const destDir = join(RUNTIME_ROOT, "sessions", r.path.replace(/[^a-zA-Z0-9_-]+/g, "--"));
						const files = readdirSync(srcDir).filter((f) => f.endsWith(".jsonl")).sort();
						const latest = files[files.length - 1];
						if (latest) {
							mkdirSync(destDir, { recursive: true });
							copyFileSync(join(srcDir, latest), join(destDir, latest));
						}
					}
				} catch { /* 无源会话 */ }
				return { ok: true, workspaceId: r.workspaceId, path: r.path, branch: r.branch };
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
			"checks.run": async ({ workspaceId, ids }) => {
				const r = await checks.run(workspaceId, ids);
				if (r.ok && r.results.length) {
					// W6:检查项结果入评审队列(人工门禁)
					const pass = r.results.filter((x: any) => x.passed).length;
					review.enqueueChecks(workspaceId, pass, r.results.length);
				}
				return r;
			},
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
			"browser.hover": async ({ workspaceId, selector }) => {
				try { return await browsers.hover(workspaceId, selector); }
				catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},
			"browser.scroll": async ({ workspaceId, x, y, selector }) => {
				try { return await browsers.scroll(workspaceId, x, y, selector); }
				catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},
			"browser.snapshot": async ({ workspaceId }) => {
				try { return await browsers.snapshot(workspaceId); }
				catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
			},
			"browser.console": ({ workspaceId, limit }) => ({ ok: true, messages: browsers.consoleMessages(workspaceId, limit) }),
			"browser.record": async ({ workspaceId, ms, intervalMs }) => {
				try { return await browsers.record(workspaceId, ms, intervalMs); }
				catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
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

			"git.fileDiff": async ({ workspaceId, path }) => {
				const r = await workspaces.fileDiff(workspaceId, path);
				return r.ok
					? { ok: true, path, headContent: r.headContent, workContent: r.workContent, headExists: r.headExists }
					: { ok: false, error: r.error };
			},
			"git.sync": async ({ workspaceId }) => {
				const r = await workspaces.sync(workspaceId);
				return r.ok ? { ok: true, fetched: r.fetched, ahead: r.ahead, behind: r.behind } : { ok: false, error: r.error };
			},
			"git.openPullRequest": async ({ workspaceId }) => {
				const url = await workspaces.remoteCompareUrl(workspaceId);
				if (!url) return { ok: false, error: "无远端或当前在 main" };
				Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
				return { ok: true, url };
			},
			"fs.search": ({ workspaceId, query, maxResults }) => {
				const { cwd } = workspaces.locate(workspaceId);
				if (!cwd) return { ok: false, error: "工作区不存在" };
				const results: Array<{ path: string; line: number; text: string }> = [];
				const q = query.toLowerCase();
				const walk = (dir: string, rel: string, depth: number) => {
					if (depth > 6 || results.length >= (maxResults ?? 100)) return;
					let entries;
					try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
					for (const e of entries) {
						if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist" || e.name === ".hutch") continue;
						const relPath = rel ? rel + "/" + e.name : e.name;
						if (e.isDirectory()) { walk(pathJoin(dir, e.name), relPath, depth + 1); continue; }
						if (!/\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs)$/.test(e.name)) continue;
						try {
							const content = readFileSync(pathJoin(dir, e.name), "utf8");
							const lines = content.split(/\r?\n/);
							for (let i = 0; i < lines.length && results.length < (maxResults ?? 100); i++) {
								const low = lines[i].toLowerCase();
								const at = low.indexOf(q);
								if (at >= 0) {
									results.push({ path: relPath, line: i + 1, text: lines[i].trim().slice(0, 160) });
								}
							}
						} catch { /* binary/locked */ }
					}
				};
				walk(cwd, "", 0);
				return { ok: true, results };
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
						titleBarStyle: "hiddenInset",
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

			/* ---------- 记忆域 M4 ---------- */
			"window.minimize": () => {
				mainWindow.minimize();
				return { ok: true };
			},
			"window.toggleMaximize": () => {
				try {
					if (windowMaximized) {
						mainWindow.unmaximize();
						windowMaximized = false;
					} else {
						mainWindow.maximize();
						windowMaximized = true;
					}
					return { ok: true, maximized: windowMaximized };
				} catch (err: any) {
					return { ok: false, error: String(err?.message ?? err) };
				}
			},
			"window.close": () => {
				mainWindow.close();
				return { ok: true };
			},

			"memory.status": ({ workspaceId }) => {
				const m = memoryFor(workspaceId);
				if (!m) return { ok: false, error: "工作区不存在" };
				return {
					ok: true,
					budget: m.budget(),
					entries: m.list().map((e) => ({ scope: e.scope, file: e.file, source: e.source, lines: e.lines, lastHit: e.lastHit })),
					agentsMd: m.readAgents(),
				};
			},
			"memory.suggest": ({ workspaceId, scope, file, lines, reason }) => {
				const m = memoryFor(workspaceId);
				if (!m) return { ok: false, error: "工作区不存在" };
				const s = m.suggest(scope, file, lines, reason);
				return { ok: true, suggestionId: s.id };
			},
			"memory.decide": ({ suggestionId, action, editedLines }) => {
				for (const [wid, m] of memories.entries()) {
					if (action === "adopt") {
						// 建议卡片本身就是人工动作;采纳后入评审队列归档(W6 记忆建议条目)
						const sg = (m as any).suggestions?.get(suggestionId);
						const r = m.adopt(suggestionId, editedLines);
						if (r.ok) {
							review.enqueueMemory(wid, "记忆 · " + (sg?.file ?? ""), (sg?.lines ?? []).slice(0, 2).join(" / "));
							return r;
						}
					} else {
						const r = m.ignore(suggestionId);
						if (r.ok) return r;
					}
				}
				return { ok: false, error: "建议不存在" };
			},
			"memory.tidy": ({ workspaceId }) => {
				const m = memoryFor(workspaceId);
				if (!m) return { ok: false, error: "工作区不存在" };
				return m.tidy();
			},
			"memory.revertTidy": ({ workspaceId }) => {
				const m = memoryFor(workspaceId);
				if (!m) return { ok: false, error: "工作区不存在" };
				return { ok: true, restored: m.revertTidy() };
			},
			"memory.recall": ({ workspaceId, keywords }) => {
				const m = memoryFor(workspaceId);
				if (!m) return { ok: false, error: "工作区不存在" };
				return { ok: true, hits: m.recallKeywords(keywords) };
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
let windowMaximized = false;

const mainWindow = new BrowserWindow({
	title: "JIDE",
	url: await getMainViewUrl(),
	rpc,
	// 无边框:自定义标题栏(hiddenInset = 无系统标题栏但保留 resize 手柄)
	titleBarStyle: "hiddenInset",
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
	bridge.stop();
	automations.dispose();
});

console.log(
	`[jide] 主进程就绪 · host=${HOST_NAME} · protocol=v${PROTOCOL_VERSION}`,
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

/* E2E 冒烟钩子 4:JIDE_SMOKE_M4=<workspaceId> 走完 M4 闭环 */
if (process.env.JIDE_SMOKE_M4) {
	const m4wid = process.env.JIDE_SMOKE_M4;
	setTimeout(async () => {
		try {
			const m = memoryFor(m4wid)!;
			// 建议卡片:提议 → 采纳
			const sg = m.suggest("project", "conventions.md", ["金额一律以「分」为整数单位计算,展示用 toFixed(2)", "浮点金额断言:期望值写字面量"], "会话沉淀:购物车修复");
			const adopt = m.adopt(sg.id);
			console.log("[jide:smoke-m4] adopt:", JSON.stringify(adopt));
			// 预算
			const inj = m.inject([]);
			console.log("[jide:smoke-m4] budget:", JSON.stringify(inj.budget), "chars:", inj.text.length);
			// 召回(命中更新 lastHit)
			const hits = m.recallKeywords(["分", "toFixed"]);
			console.log("[jide:smoke-m4] recall hits:", hits.length, hits[0]?.line?.slice(0, 30));
			// AGENTS.md 只读
			console.log("[jide:smoke-m4] agentsMd readonly:", m.readAgents()?.slice(0, 40) ?? "(none)");
			// 建议卡片三动作(忽略/改后采纳在 UI;这里验证第二条建议走 adopt-with-edit)
			const sg2 = m.suggest("user", "feedback.md", ["原始稿"], "编辑演示");
			const editAdopt = m.adopt(sg2.id, ["用户改后的稿子"]);
			console.log("[jide:smoke-m4] adopt-edited:", JSON.stringify(editAdopt));
			// 整理 + 回退
			const tidy = m.tidy();
			console.log("[jide:smoke-m4] tidy:", JSON.stringify({ before: tidy.before, after: tidy.after, changed: tidy.changed.length }));
			const reverted = m.revertTidy();
			console.log("[jide:smoke-m4] revertTidy restored:", reverted);
			// 注入进新会话(session.create 路径带 memoryContext)
			const entry = await host.createSession({ workspacePath: workspaces.locate(m4wid).cwd ?? "", demoMode: true, memoryContext: m.inject([]).text, agentsMd: m.readAgents() });
			console.log("[jide:smoke-m4] session with memory created:", entry.sessionId.slice(0, 8));
			console.log("[jide:smoke-m4] ALL DONE");
		} catch (e) {
			console.log("[jide:smoke-m4] ERR", e);
		}
	}, 5000);
}
